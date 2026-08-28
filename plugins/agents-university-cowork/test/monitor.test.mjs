import assert from 'node:assert/strict';
import test from 'node:test';
import { MonitorManager } from '../src/monitor-manager.mjs';

const CID = 'A'.repeat(64); const WIRE = 'B'.repeat(64);
const row = { room_name: 'Room', identity_name: 'Tutor', contact_cid: CID, membership_state: 'connecting' };
test('first valid arrival promotes without draining unread and wakes body-free', async () => {
  const calls = []; const pushed = [];
  const client = {
    async listContacts() { calls.push('contacts'); return { contacts: [{ container_id: CID }] }; },
    async getHistoryItem() { calls.push('history'); return { body: JSON.stringify({ version: 1, kind: 'room_msg', room_id: 'r1', room_name: 'Room', at: '2026-08-28T00:00:00.000Z', author: { display_name: 'Alice', identity: CID, role: 'Owner' }, message_id: 'm1', text: 'secret' }) }; }
  };
  const registry = { async updateState() { calls.push('promote'); return { ...row, membership_state: 'ready' }; } };
  const server = { sendLoggingMessage(v) { pushed.push(JSON.parse(v.data)); } };
  await new MonitorManager({ server, registry }).handle(client, row, { event: 'message_received', sender_id: CID, wire_id: WIRE });
  assert.deepEqual(calls, ['contacts', 'history', 'promote']); assert.equal(pushed.length, 1); assert.equal(pushed[0].wire_id, WIRE); assert.equal('body' in pushed[0], false);
  assert.equal('getMessages' in client, false);
});

test('wrong CID and malformed message stay invisible; file author is not inferred', async () => {
  const pushed = []; let promotions = 0; const localRow = { ...row, membership_state: 'connecting' }; const client = { async listContacts() { return { contacts: [{ container_id: CID }] }; }, async getHistoryItem() { return { body: 'not json' }; } };
  const registry = { async updateState() { promotions += 1; return { ...localRow, membership_state: 'ready' }; } }; const server = { sendLoggingMessage(v) { pushed.push(JSON.parse(v.data)); } };
  const monitor = new MonitorManager({ server, registry });
  await monitor.handle(client, localRow, { event: 'message_received', sender_id: 'C'.repeat(64), wire_id: WIRE });
  await monitor.handle(client, localRow, { event: 'message_received', sender_id: CID, wire_id: WIRE });
  assert.equal(promotions, 0);
  await monitor.handle(client, localRow, { event: 'file_received', sender_id: CID, wire_id: WIRE, filename: 'guess.txt' });
  assert.equal(promotions, 1); assert.equal(pushed.length, 1); assert.equal(pushed[0].event, 'room_file_available'); assert.equal('author' in pushed[0], false); assert.equal('filename' in pushed[0], false);
});

test('cursor-zero replay catches arrival after snapshots but before server capture without draining', async () => {
  const pushed = []; const calls = []; let arrived = false; let releaseCapture; const captured = new Promise((resolve) => { releaseCapture = resolve; });
  const localRow = { ...row, membership_state: 'ready' };
  const client = {
    async * watchNotifications(_identity, options) { calls.push(['watch-local', options.since]); await captured; calls.push('server-captured'); yield { event: 'message_received', sender_id: CID, wire_id: 'C'.repeat(64) }; yield { event: 'message_received', sender_id: CID, wire_id: WIRE }; await new Promise(() => {}); },
    async listIncomingMessages() { calls.push('message-snapshot'); return arrived ? [{ wire_id: WIRE, from: { id: CID } }] : []; },
    async listIncomingFiles() { calls.push('file-snapshot'); return []; },
    async listContacts() { return { contacts: [{ container_id: CID }] }; },
    async getHistoryItem() { return { body: JSON.stringify({ version: 1, kind: 'room_msg', room_id: 'r1', room_name: 'Room', at: '2026-08-28T00:00:00.000Z', author: { display_name: 'Alice', identity: CID, role: 'Owner' }, message_id: 'm1', text: 'secret' }) }; }
  };
  const monitor = new MonitorManager({ server: { sendLoggingMessage(v) { pushed.push(JSON.parse(v.data)); } }, registry: {} });
  monitor.start(client, localRow); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.includes('message-snapshot')); assert.ok(calls.includes('file-snapshot')); arrived = true; releaseCapture(); await new Promise((resolve) => setTimeout(resolve, 10)); monitor.stop();
  assert.deepEqual(calls[0], ['watch-local', 0]); assert.ok(calls.includes('server-captured')); assert.equal(pushed.length, 1);
  assert.equal('getMessages' in client, false); assert.equal('getFiles' in client, false);
});

test('dedupe survives transient cursor-zero retries and distinct unread wires wake once', async () => {
  const wire2 = 'D'.repeat(64); let attempts = 0; let unread = [{ wire_id: WIRE, from: { id: CID } }]; const pushed = [];
  const localRow = { ...row, membership_state: 'ready' };
  const client = {
    async * watchNotifications() { attempts += 1; yield { event: 'message_received', sender_id: CID, wire_id: WIRE }; if (attempts === 1) { unread = [...unread, { wire_id: wire2, from: { id: CID } }]; throw new Error('transient'); } await new Promise(() => {}); },
    async listIncomingMessages() { return unread; }, async listIncomingFiles() { return []; },
    async listContacts() { return { contacts: [{ container_id: CID }] }; },
    async getHistoryItem({ wire_id }) { return { body: JSON.stringify({ version: 1, kind: 'room_msg', room_id: 'r1', room_name: 'Room', at: '2026-08-28T00:00:00.000Z', author: { display_name: 'Alice', identity: CID, role: 'Owner' }, message_id: wire_id, text: 'secret' }) }; }
  };
  let monitor; const server = { sendLoggingMessage(v) { pushed.push(JSON.parse(v.data)); if (pushed.length === 2) monitor.stop(); } };
  monitor = new MonitorManager({ server, registry: {}, random: () => 0 }); monitor.start(client, localRow);
  await new Promise((resolve) => setTimeout(resolve, 550)); monitor.stop();
  assert.equal(attempts, 2); assert.deepEqual(pushed.map((item) => item.wire_id), [WIRE, wire2]);
});
