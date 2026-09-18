// Accepted backend regression coverage; see docs/product-tools.md.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentHarness } from "../src/product/agent-harness.mjs";
const room = "a".repeat(64), other = "b".repeat(64);
function result(sender, wire, outcome) {
  return { direction: "in", from: { id: sender }, message_kind: "command_result", reply_to: { wire_id: wire }, body: JSON.stringify(outcome) };
}
const success = { ok: true, result: { ok: true, result: { status: "ok", data: { goal: "Actual goal" } } } };
test("agent consumer tool authenticates typed result sender/reply and unwraps SDK plus product outcome", async () => {
  let sends = 0, reads = 0;
  const sdk = { sendCommand: async (input) => {
    sends++;
    assert.equal(input.contact, room.toUpperCase());
    assert.equal(input.command, "consumer.ac.read");
    assert.deepEqual(input.arguments, { kind: "context" });
    return { sent: true, wire_id: "request", kind: "sent" };
  }, getMessages: async () => {
    reads++;
    return { messages: [result(room, "request", success)], command_results: reads === 1 ? [result(other, "request", success), result(room, "wrong", success)] : [result(room, "request", success)], remaining: 0, commands_handled: 0 };
  } };
  const harness = new AgentHarness(sdk, { roomCid: room, timeoutMs: 200, pollMs: 1 });
  const received = await harness.call("ac_read", { kind: "context" });
  assert.equal(received.status, "ok");
  assert.equal(received.data.goal, "Actual goal");
  assert.equal(sends, 1);
  assert.equal(reads, 2);
  const unread = harness.takeReceived();
  assert.equal(unread.messages.length, 2);
  assert.equal(unread.unmatched_results.length, 2);
});
test("agent command timeout, transport refusal and failed nested result never become business success or replay", async () => {
  let sends = 0;
  const empty = { messages: [], command_results: [], remaining: 0, commands_handled: 0 };
  const harness = new AgentHarness({ sendCommand: async () => {
    sends++;
    return { sent: true, wire_id: "request", kind: "sent" };
  }, getMessages: async () => empty }, { roomCid: room, timeoutMs: 10, pollMs: 1 });
  assert.equal((await harness.call("ac_read", { kind: "room" })).status, "unknown");
  assert.equal(sends, 1);
  const rejected = new AgentHarness({ sendCommand: async () => ({ sent: true, wire_id: "request", kind: "sent" }), getMessages: async () => ({ ...empty, command_results: [result(room, "request", { ok: true, result: { ok: true, result: { status: "rejected", error: { code: "forbidden", message: "Denied" } } } })] }) }, { roomCid: room, timeoutMs: 100, pollMs: 1 });
  assert.equal((await rejected.call("ac_read", { kind: "room" })).status, "rejected");
  const refused = new AgentHarness({ sendCommand: async () => ({ kind: "refused" }), getMessages: async () => {
    throw Error("Must not read after refusal");
  } }, { roomCid: room, timeoutMs: 100, pollMs: 1 });
  assert.equal((await refused.call("ac_read", { kind: "room" })).status, "not_sent");
});
test("late typed results can be consumed explicitly after timeout without repeating the original command", async () => {
  let ready = false, sends = 0;
  const sdk = { sendCommand: async () => {
    sends++;
    return { sent: true, wire_id: "late", kind: "sent" };
  }, getMessages: async () => ({ messages: [], command_results: ready ? [result(room, "late", success)] : [], commands_handled: 0, remaining: 0 }) };
  const harness = new AgentHarness(sdk, { roomCid: room, timeoutMs: 10, pollMs: 1 });
  assert.equal((await harness.call("ac_read", { kind: "room" })).status, "unknown");
  ready = true;
  const received = await harness.call("ac_messages", {});
  assert.equal(received.command_results[0].request_wire_id, "late");
  assert.equal(received.command_results[0].result.status, "ok");
  assert.equal(sends, 1);
});
test("ac_messages drains retained capacity without fresh polling and then receives the late command result", async () => {
  let reads = 0, sends = 0, ready = false;
  const sdk = { sendCommand: async () => {
    sends++;
    return { sent: true, wire_id: "filled", kind: "sent" };
  }, getMessages: async () => {
    reads++;
    if (!ready) return { messages: Array.from({ length: 100 }, () => ({ text: "Retained mail" })), command_results: [], remaining: 0, commands_handled: 0 };
    return { messages: [], command_results: [result(room, "filled", success)], remaining: 0, commands_handled: 0 };
  } };
  const harness = new AgentHarness(sdk, { roomCid: room, timeoutMs: 1e3, pollMs: 1 });
  assert.equal((await harness.call("ac_read", { kind: "room" })).status, "unknown");
  assert.equal(reads, 10);
  sdk.getMessages = async () => {
    throw Error("Offline");
  };
  const drained = await harness.call("ac_messages", {});
  assert.equal(drained.messages.length, 1e3);
  assert.equal(reads, 10);
  ready = true;
  sdk.getMessages = async () => ({ messages: [], command_results: [result(room, "filled", success)], remaining: 0, commands_handled: 0 });
  const late = await harness.call("ac_messages", {});
  assert.equal(late.command_results[0].result.status, "ok");
  assert.equal(sends, 1);
});
test("ac_messages honors selected unread wires and bounded retained pages without discarding other mail", async () => {
  let reads = 0;
  const sdk = { getMessages: async (input) => {
    reads++;
    assert.deepEqual(input, { limit: 1, wire_ids: ["b"] });
    return { messages: [{ wire_id: "a", text: "A" }, { wire_id: "b", text: "B" }, { wire_id: "c", text: "C" }], command_results: [], remaining: 0, commands_handled: 0 };
  } };
  const harness = new AgentHarness(sdk, { roomCid: room, timeoutMs: 100, pollMs: 1 });
  assert.deepEqual((await harness.call("ac_messages", { wire_ids: ["b"], limit: 1 })).messages.map((m) => m.wire_id), ["b"]);
  assert.deepEqual((await harness.call("ac_messages", { limit: 1 })).messages.map((m) => m.wire_id), ["a"]);
  assert.deepEqual((await harness.call("ac_messages", {})).messages.map((m) => m.wire_id), ["c"]);
  assert.equal(reads, 1);
});
