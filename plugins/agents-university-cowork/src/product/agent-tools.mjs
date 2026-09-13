// Ported from accepted backend dfe3a879; see docs/product-tools.md.
import { z } from "zod";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AgentHarness, messageSelection } from "./agent-harness.mjs";
import { cid, id, limits, consumerCommands, schemas } from "./contracts.mjs";
import { DomainError, fail } from "./errors.mjs";
const empty = z.object({}).strict();
const metadata = z.string().min(1).refine((value) => Buffer.byteLength(value) <= limits.metadata_bytes);
const reply = { reply_to_wire_id: id.optional(), reply_to_sentence: z.number().int().positive().safe().optional() };
const validReply = (value) => value.reply_to_sentence === void 0 || value.reply_to_wire_id !== void 0;
const message = z.object({ text: z.string().min(1).refine((value) => Array.from(value).length <= limits.text_characters), ...reply }).strict().refine(validReply, "Reply sentence requires a parent wire.");
const sendFile = z.union([z.object({ path: z.string().min(1), filename: metadata.optional(), mime: metadata.optional(), ...reply }).strict(), z.object({ data_base64: z.string().max(Math.ceil(limits.file_bytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), filename: metadata, mime: metadata.optional(), ...reply }).strict()]).refine(validReply, "Reply sentence requires a parent wire.");
const files = z.union([z.object({ wire_ids: z.array(id).min(1).max(100).refine((values) => new Set(values).size === values.length).optional(), limit: z.number().int().min(1).max(100).optional() }).strict().refine((value) => value.limit === void 0 || value.wire_ids !== void 0, "File consumption requires explicit selected wires."), z.object({ open_wire_id: id }).strict()]);
function registerAgentTools(register, client, configuration) {
  const roomCid = cid.parse(configuration.roomCid).toUpperCase(), harness = new AgentHarness(client, configuration);
  const add = (name, description, inputSchema, run) => register({ name, description, inputSchema, execute: async (input) => run(inputSchema.parse(input)) });
  for (const [command, operation] of Object.entries(consumerCommands)) {
    const name = command.replace("consumer.", "").replaceAll(".", "_");
    add(name, `Call ${command} under current product authorization.`, schemas[operation], (input) => harness.call(name, input));
  }
  add("ac_messages", "Read typed command results and ordinary messages without command replay.", messageSelection, (input) => harness.call("ac_messages", input));
  add("ac_commands", "Read the advertised room catalogue and current product capabilities.", empty, async () => ({ advertised: await client.listContactCommands({ contact: roomCid }), capabilities: await harness.call("ac_read", { kind: "capabilities" }) }));
  add("ac_message", "Send a public room message or an ordinary reply.", message, (input) => client.sendMessage({ contact: roomCid, ...input }));
  add("ac_join", "Use the supplied invitation; product admission still requires approved binding.", z.object({ invite: z.string().min(1).max(65536), name: z.string().min(1).max(128).optional() }).strict(), (input) => client.addContact(input));
  add("ac_send_file", "Send artifact bytes to the room; the receipt does not register a version.", sendFile, async (input) => {
    if ("path" in input) {
      const file = await stat(input.path);
      if (!file.isFile() || file.size > limits.file_bytes) fail(413, "file_too_large", "Artifact is not a supported bounded file.");
    } else if (Buffer.from(input.data_base64, "base64").length > limits.file_bytes) fail(413, "file_too_large", "Artifact exceeds the room file limit.");
    return client.sendFile({ contact: roomCid, ...input });
  });
  add("ac_files", "List or receive room files; open stored bytes through the bound SDK daemon.", files, async (input) => {
    if ("open_wire_id" in input) {
      const before = await client.getFileInfo({ wire_id: input.open_wire_id });
      if (!before || before.direction !== "in" || before.from.id.toUpperCase() !== roomCid || before.wire_id !== input.open_wire_id) fail(404, "not_found", "Room file not found.");
      if (before.size > limits.file_bytes) fail(413, "file_too_large", "Artifact exceeds the room file limit.");
      const stream = await client.openFile(input.open_wire_id), reader = stream.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limits.file_bytes) {
            await reader.cancel();
            fail(413, "file_too_large", "Artifact exceeds the room file limit.");
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks), after = await client.getFileInfo({ wire_id: input.open_wire_id });
      if (!after || after.direction !== "in" || after.from.id.toUpperCase() !== roomCid || after.wire_id !== before.wire_id || after.sha256 !== before.sha256 || after.size !== before.size || size !== before.size || createHash("sha256").update(bytes).digest("hex") !== before.sha256) fail(422, "invalid_version_hash", "Received bytes no longer match the selected file.");
      return { file: after, data_base64: bytes.toString("base64") };
    }
    const incoming = (await client.listIncomingFiles()).filter((file) => file.direction === "in" && file.from.id.toUpperCase() === roomCid);
    if (!input.wire_ids) return { incoming };
    if (input.wire_ids.some((wire) => !incoming.some((file) => file.wire_id === wire))) fail(404, "not_found", "Selected room file is not incoming.");
    let received;
    try {
      received = await client.getFiles({ wire_ids: input.wire_ids, ...input.limit !== void 0 ? { limit: input.limit } : {} });
    } catch {
      throw new DomainError(503, "dependency_unavailable", "File receive outcome is unknown; unread consumption may have occurred.", "unknown");
    }
    if (received.files.some((file) => file.from.id.toUpperCase() !== roomCid || !input.wire_ids.includes(file.wire_id))) throw new DomainError(503, "dependency_unavailable", "Received file association does not match the selection.", "committed");
    return received;
  });
  return harness;
}
export {
  registerAgentTools
};
