// Accepted backend regression coverage; see docs/product-tools.md.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerAgentTools } from "../src/product/agent-tools.mjs";
const room = "A".repeat(64), other = "B".repeat(64);
test("local tool registration uses SDK room calls, selects only room files and streams verified received bytes", async () => {
  const tools = /* @__PURE__ */ new Map(), calls = [];
  const bytes = Buffer.from("Artifact"), hash = createHash("sha256").update(bytes).digest("hex");
  const file = { wire_id: "file", direction: "in", from: { id: room }, size: bytes.length, sha256: hash, filename: "doc.txt", mime: "text/plain" };
  const sdk = { sendMessage: async (input) => {
    calls.push("message");
    assert.equal(input.contact, room);
    assert.equal(input.reply_to_wire_id, "parent");
    return { sent: true, wire_id: "sent" };
  }, sendFile: async (input) => {
    calls.push("file");
    assert.equal(input.contact, room);
    return { sent: true, wire_id: "source" };
  }, addContact: async (input) => {
    calls.push("join");
    assert.equal(input.invite, "human-invite");
    return { status: "introduced" };
  }, listIncomingFiles: async () => [file, { ...file, wire_id: "foreign", from: { id: other } }], getFiles: async (input) => {
    calls.push("getFiles");
    assert.deepEqual(input.wire_ids, ["file"]);
    return { files: [file], remaining: 0 };
  }, getFileInfo: async () => file, openFile: async () => new ReadableStream({ start(c) {
    c.enqueue(bytes);
    c.close();
  } }) };
  registerAgentTools((tool) => tools.set(tool.name, tool), sdk, { roomCid: room, timeoutMs: 100, pollMs: 1 });
  assert.equal(tools.size, 23);
  assert.deepEqual(calls, []);
  await tools.get("ac_message").execute({ text: "Reply", reply_to_wire_id: "parent" });
  await tools.get("ac_send_file").execute({ data_base64: bytes.toString("base64"), filename: "doc.txt" });
  await tools.get("ac_join").execute({ invite: "human-invite" });
  const list = await tools.get("ac_files").execute({});
  assert.equal(list.incoming.length, 1);
  await assert.rejects(tools.get("ac_files").execute({ wire_ids: ["foreign"] }), (e) => e.status === 404);
  await tools.get("ac_files").execute({ wire_ids: ["file"] });
  const opened = await tools.get("ac_files").execute({ open_wire_id: "file" });
  assert.equal(opened.data_base64, bytes.toString("base64"));
  assert.deepEqual(calls, ["message", "file", "join", "getFiles"]);
  await assert.rejects(tools.get("ac_message").execute({ text: "Private", audience: { kind: "restricted" } }));
});
test("streamed agent files reject changed sender and bytes that do not match authenticated metadata", async () => {
  for (const mode of ["sender", "bytes"]) {
    const tools = /* @__PURE__ */ new Map();
    let reads = 0;
    const bytes = Buffer.from("Artifact");
    const file = { wire_id: "file", direction: "in", from: { id: room }, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), filename: "doc.txt", mime: "text/plain" };
    const sdk = { getFileInfo: async () => {
      reads++;
      return { ...file, from: { id: mode === "sender" && reads > 1 ? other : room } };
    }, openFile: async () => new ReadableStream({ start(c) {
      c.enqueue(mode === "bytes" ? Buffer.from("Tampered") : bytes);
      c.close();
    } }) };
    registerAgentTools((tool) => tools.set(tool.name, tool), sdk, { roomCid: room, timeoutMs: 100, pollMs: 1 });
    await assert.rejects(tools.get("ac_files").execute({ open_wire_id: "file" }), (e) => e.code === "invalid_version_hash");
  }
});
test("ac_commands combines native advertisement with a separately authenticated current capabilities result", async () => {
  const tools = /* @__PURE__ */ new Map();
  let advertised = 0, sent = 0;
  const sdk = { listContactCommands: async (input) => {
    assert.equal(input.contact, room);
    advertised++;
    return [{ name: "consumer.ac.read" }];
  }, sendCommand: async (input) => {
    sent++;
    assert.deepEqual(input.arguments, { kind: "capabilities" });
    return { sent: true, wire_id: "request" };
  }, getMessages: async () => ({ messages: [], command_results: [{ direction: "in", from: { id: room }, message_kind: "command_result", reply_to: { wire_id: "request" }, body: JSON.stringify({ ok: true, result: { ok: true, result: { status: "ok", data: { available_actions: [] } } } }) }] }) };
  registerAgentTools((tool) => tools.set(tool.name, tool), sdk, { roomCid: room, timeoutMs: 100, pollMs: 1 });
  const view = await tools.get("ac_commands").execute({});
  assert.equal(view.advertised.length, 1);
  assert.deepEqual(view.capabilities.data.available_actions, []);
  assert.equal(advertised, 1);
  assert.equal(sent, 1);
});
test("message and file tools preserve SDK reply sentence fields and reject sentence without parent", async () => {
  const tools = /* @__PURE__ */ new Map(), sent = [];
  registerAgentTools((tool) => tools.set(tool.name, tool), { sendMessage: async (input) => {
    sent.push(input);
    return { sent: true };
  }, sendFile: async (input) => {
    sent.push(input);
    return { sent: true };
  } }, { roomCid: room, timeoutMs: 100, pollMs: 1 });
  await tools.get("ac_message").execute({ text: "Reply", reply_to_wire_id: "parent", reply_to_sentence: 2 });
  await tools.get("ac_send_file").execute({ data_base64: "YQ==", filename: "a.txt", reply_to_wire_id: "parent", reply_to_sentence: 3 });
  assert.deepEqual(sent.map((input) => [input.contact, input.reply_to_wire_id, input.reply_to_sentence]), [[room, "parent", 2], [room, "parent", 3]]);
  await assert.rejects(tools.get("ac_message").execute({ text: "Reply", reply_to_sentence: 2 }));
  await assert.rejects(tools.get("ac_send_file").execute({ data_base64: "YQ==", filename: "a.txt", reply_to_sentence: 3 }));
  assert.equal(sent.length, 2);
});
test("selected file reads forward the explicit batch bound without allowing broad consumption", async () => {
  const tools = /* @__PURE__ */ new Map();
  let reads = 0;
  const file = { wire_id: "file", direction: "in", from: { id: room } };
  registerAgentTools((tool) => tools.set(tool.name, tool), { listIncomingFiles: async () => [file], getFiles: async (input) => {
    reads++;
    assert.deepEqual(input, { wire_ids: ["file"], limit: 1 });
    return { files: [file], remaining: 0 };
  } }, { roomCid: room, timeoutMs: 100, pollMs: 1 });
  await tools.get("ac_files").execute({ wire_ids: ["file"], limit: 1 });
  await assert.rejects(tools.get("ac_files").execute({ limit: 1 }));
  assert.equal(reads, 1);
});

// During a review of this plugin, one participant's long messages arrived twice — to two
// independent recipients each — while a three-character message from the same sender arrived once.
// That ruled out a per-recipient glitch and left the send path under suspicion. This pins the part
// this repo owns: one ac_message call performs exactly one SDK send, so a resend can never be
// introduced here without a test failing. It does not clear the SDK or the room's fanout, which
// are outside this repo; it removes the plugin from the list of suspects and keeps it removed.
test("one ac_message call performs exactly one SDK send", async () => {
  const tools = new Map(); let sends = 0;
  const sdk = { sendMessage: async () => { sends += 1; return { sent: true, wire_id: `w${sends}` }; } };
  registerAgentTools((tool) => tools.set(tool.name, tool), sdk, { roomCid: room, timeoutMs: 1000, pollMs: 5 });
  await tools.get("ac_message").execute({ text: "one" });
  assert.equal(sends, 1, `ac_message performed ${sends} SDK sends for a single call`);
  await tools.get("ac_message").execute({ text: "two" });
  assert.equal(sends, 2, "a second call must add exactly one more send, not two");
});
