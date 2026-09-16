// Ported from accepted backend dfe3a879; see docs/product-tools.md.
import { z } from "zod";
import { cid, id, consumerCommands, consumerToolName, schemas } from "./contracts.mjs";
import { fail } from "./errors.mjs";
const messageSelection = z.object({ wire_ids: z.array(id).min(1).max(100).refine((values) => new Set(values).size === values.length).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const sdkOutcome = z.union([z.object({ ok: z.literal(true), result: z.unknown() }).strict(), z.object({ ok: z.literal(false), error: z.string(), execution: z.string().optional() }).strict()]);
const productOutcome = z.union([z.object({ status: z.enum(["ok", "committed"]), data: z.unknown() }).strict(), z.object({ status: z.literal("rejected"), error: z.object({ code: z.string(), message: z.string() }).strict() }).strict()]);
const commands = Object.fromEntries(Object.entries(consumerCommands).map(([command, operation]) => [consumerToolName(command), { command, operation }]));
class AgentHarness {
  constructor(client, configuration) {
    this.client = client;
    this.configuration = configuration;
    this.roomCid = cid.parse(configuration.roomCid).toUpperCase();
    z.number().int().min(1).max(3e4).parse(configuration.timeoutMs);
    z.number().int().min(1).max(configuration.timeoutMs).parse(configuration.pollMs);
  }
  roomCid;
  busy = false;
  reading;
  pending = /* @__PURE__ */ new Map();
  messages = [];
  unmatched = [];
  consume(selection = {}) {
    if (this.reading) return this.reading;
    if (this.messages.length + this.unmatched.length >= 1e3) fail(409, "invalid_state", "Read retained agent messages before consuming another batch.");
    this.reading = this.client.getMessages({ limit: selection.limit ?? 100, ...selection.wire_ids ? { wire_ids: selection.wire_ids } : {} }).then((batch) => {
      this.messages.push(...batch.messages);
      for (const message of batch.command_results ?? []) {
        const request = message.reply_to?.wire_id, tracked = request ? this.pending.get(request) : void 0;
        if (message.message_kind !== "command_result" || message.direction !== "in" || message.from.id.toUpperCase() !== this.roomCid || !tracked || tracked.result) {
          this.unmatched.push(message);
          continue;
        }
        let outcome = { status: "unknown", request_wire_id: request };
        try {
          if (Buffer.byteLength(message.body) > 256 * 1024) throw Error("oversized");
          const sdk = sdkOutcome.parse(JSON.parse(message.body));
          if (sdk.ok) {
            const consumer = sdkOutcome.parse(sdk.result);
            if (consumer.ok) {
              const product = productOutcome.parse(consumer.result);
              if (!Object.hasOwn(product, "data") && product.status !== "rejected") throw Error("missing data");
              outcome = product.status === "rejected" ? product : { status: product.status, data: product.data };
            }
          }
        } catch {
        }
        tracked.result = outcome;
        tracked.received_wire_id = message.wire_id;
      }
    }).finally(() => {
      this.reading = void 0;
    });
    return this.reading;
  }
  receivedPage(selection = {}) {
    const results = [];
    for (const [wire, entry] of this.pending) if (entry.result) results.push({ request_wire_id: wire, command: entry.command, result: entry.result, ...entry.received_wire_id ? { wire_id: entry.received_wire_id } : {} });
    let bytes = 256, count = 0;
    const selectedWire = (item) => !selection.wire_ids || selection.wire_ids.includes(item.wire_id);
    const select = (items) => {
      const selected = [];
      for (const item of items) {
        if (!selectedWire(item)) continue;
        if (count >= (selection.limit ?? Infinity)) break;
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes + size > 15e5) break;
        bytes += size;
        count++;
        selected.push(item);
      }
      return selected;
    };
    const messages = select(this.messages), unmatched_results = select(this.unmatched), command_results = select(results);
    const remaining = this.messages.length + this.unmatched.length + results.length - messages.length - unmatched_results.length - command_results.length;
    if ([...this.messages, ...this.unmatched, ...results].some(selectedWire) && !messages.length && !unmatched_results.length && !command_results.length) fail(413, "payload_too_large", "A retained mail item exceeds the response page limit; data remains retained.");
    return { messages, unmatched_results, command_results, remaining };
  }
  /** Acknowledge only the exact prepared selection after the caller validates output. */
  acknowledgeReceived(value) {
    const page = value;
    if (!page || !Array.isArray(page.messages) || !Array.isArray(page.unmatched_results) || !Array.isArray(page.command_results)) return;
    if (page.messages.some((item) => !this.messages.includes(item)) || page.unmatched_results.some((item) => !this.unmatched.includes(item)) || page.command_results.some((item) => this.pending.get(item.request_wire_id)?.result !== item.result)) fail(409, "invalid_state", "Retained mail changed before response acknowledgement.");
    this.messages = this.messages.filter((item) => !page.messages.includes(item));
    this.unmatched = this.unmatched.filter((item) => !page.unmatched_results.includes(item));
    for (const item of page.command_results) this.pending.delete(item.request_wire_id);
  }
  acknowledgeCommandResult(value) {
    for (const [wire, entry] of this.pending) if (entry.result === value) this.pending.delete(wire);
  }
  takeReceived(selection = {}) {
    const page = this.receivedPage(selection);
    this.acknowledgeReceived(page);
    return page;
  }
  async before(promise, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error("deadline");
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("deadline")), remaining);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async call(name, input, options) {
    if (this.busy) fail(409, "invalid_state", "Another harness command is still awaiting its result.");
    const command = Object.hasOwn(commands, name) ? commands[name] : void 0;
    if (name !== "ac_messages" && !command) fail(400, "invalid_request", "Unknown local agent tool.");
    const arguments_ = command ? schemas[command.operation].parse(input) : messageSelection.parse(input);
    if (command && this.pending.size >= 100) fail(409, "invalid_state", "Too many unresolved commands; inspect retained results.");
    this.busy = true;
    const deadline = Date.now() + this.configuration.timeoutMs;
    let wire;
    try {
      if (name === "ac_messages") {
        const selection = arguments_;
        let page = this.receivedPage(selection);
        if (!page.messages.length && !page.unmatched_results.length && !page.command_results.length) {
          await this.before(this.consume(selection), deadline);
          page = this.receivedPage(selection);
        }
        if (!options?.retainReceived) this.acknowledgeReceived(page);
        return page;
      }
      const receipt = await this.before(this.client.sendCommand({ contact: this.roomCid, command: command.command, arguments: arguments_ }), deadline);
      if (!("sent" in receipt) || receipt.sent !== true || !("wire_id" in receipt) || !receipt.wire_id) return { status: "not_sent" };
      wire = receipt.wire_id;
      if (this.pending.has(wire)) return { status: "unknown", request_wire_id: wire };
      const tracked = { command: command.command };
      this.pending.set(wire, tracked);
      while (Date.now() < deadline) {
        await this.before(this.consume(), deadline);
        if (tracked.result) {
          if (!options?.retainReceived) this.pending.delete(wire);
          return tracked.result;
        }
        await this.before(new Promise((resolve) => setTimeout(resolve, this.configuration.pollMs)), deadline);
      }
      return { status: "unknown", request_wire_id: wire };
    } catch {
      return { status: "unknown", ...wire ? { request_wire_id: wire } : {} };
    } finally {
      this.busy = false;
    }
  }
}
export {
  AgentHarness,
  messageSelection
};
