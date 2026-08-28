import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../src/server.mjs';

const CID = 'A'.repeat(64); const WIRE = 'B'.repeat(64);
const envelope = JSON.stringify({ version: 1, kind: 'room_msg', room_id: 'r1', room_name: 'Room', at: '2026-08-28T00:00:00.000Z', author: { display_name: 'Alice', identity: CID, role: 'Owner' }, message_id: 'm1', text: 'hello' });
class FakeServer {
  constructor() { this.tools = new Map(); this.pushes = []; }
  registerTool(name, config, fn) { this.tools.set(name, { config, fn }); }
  sendLoggingMessage(v) { this.pushes.push(v); }
}
const watcher = async function * ({ signal } = {}) { await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true })); };
function client(overrides = {}) {
  const calls = []; let roleExists = false; let roleSession = null;
  return { calls,
    async listIdentities() { return [{ name: 'Human', kind: 'root', session: null }, ...(roleExists ? [{ name: 'Tutor', kind: 'role', session: roleSession }] : [])]; }, async createIdentity(v) { calls.push(['createIdentity', v]); roleExists = true; roleSession = 'mine'; },
    async addContact() { calls.push(['addContact']); return { cid: CID, display: 'Room' }; }, async removeContact(v) { calls.push(['removeContact', v]); }, async removeIdentity(v) { calls.push(['removeIdentity', v]); },
    async chooseIdentity(v) { calls.push(['chooseIdentity', v]); roleExists = true; roleSession = 'mine'; }, async listContacts() { return { contacts: [{ container_id: CID }], pending: [] }; },
    async releaseLease() { calls.push(['releaseLease']); roleSession = null; }, async listIncomingMessages() { return []; }, async listIncomingFiles() { return []; }, watchNotifications: watcher,
    async sendMessage(v) { calls.push(['sendMessage', v]); return { kind: 'e2e', history_stored: true }; },
    async getMessages(v) { calls.push(['getMessages', v]); return { messages: [{ from: { id: CID }, body: envelope, date: 'fallback' }], remaining: 0 }; },
    async listHistory(v) { calls.push(['listHistory', v]); return { items: [{ wire_id: WIRE, body: envelope }], next_cursor: null }; },
    async uploadFile(bytes, meta) { calls.push(['uploadFile', bytes.byteLength, meta]); return { upload_id: 'u1', filename: meta.filename, mime: 'text/plain' }; },
    async sendFile(v) { calls.push(['sendFile', v]); return { kind: 'e2e' }; },
    async getFiles(v) { calls.push(['getFiles', v]); return { files: [{ wire_id: WIRE, from: { id: CID }, filename: 'a.txt', mime: 'text/plain', size: 2, date: 'now', path: '/sdk/blob/a' }], remaining: 0 }; },
    ...overrides };
}
function registry(initial = []) {
  const rows = [...initial]; return { rows, async init() {}, async list() { return rows; }, async get(name) { return rows.find((r) => r.room_name === name) ?? null; },
    async create(v) { const row = { room_name: v.roomName, identity_name: v.identityName, contact_cid: v.contactCid, membership_state: v.membershipState }; rows.push(row); return row; },
    async updateState(name, membership_state) { const row = rows.find((r) => r.room_name === name); row.membership_state = membership_state; return row; } };
}
function session(c) { return { selection: { expectStateDir: '/fake' }, client: c, bound: null, async ensureAttached() { return this.client; }, async release() { this.bound = null; await c.releaseLease(); } }; }
const data = (result) => { assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent)); return result.structuredContent.data; };

test('all ten registered handlers execute success schemas against SDK 3.6.0 shapes', async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-handler-')); const file = path.join(source, 'a.txt'); await fs.writeFile(file, 'ok');
  const c = client(); c.getFiles = async (v) => { c.calls.push(['getFiles', v]); return { files: [{ wire_id: WIRE, from: { id: CID }, filename: 'a.txt', mime: 'text/plain', size: 2, date: 'now', path: file }], remaining: 0 }; }; const s = session(c); const srv = new FakeServer(); const reg = registry(); const runtime = await createRuntime({ session: s, server: srv, registry: reg });
  assert.equal(srv.tools.size, 10);
  data(await srv.tools.get('enter_room').fn({ invite: 'invite', as_agent: 'Tutor' }));
  let listed = data(await srv.tools.get('list_rooms').fn({})).rooms[0]; assert.equal(listed.status, 'connected'); assert.equal(listed.membership_state, 'ready'); assert.equal(listed.bind_state, 'bound_here');
  assert.equal(data(await srv.tools.get('get_room_status').fn({})).status, 'connected');
  assert.equal(data(await srv.tools.get('send_room_message').fn({ text: 'hi' })).outcome, 'e2e');
  assert.equal(data(await srv.tools.get('read_room_messages').fn({ limit: 1 })).messages[0].message_id, 'm1');
  assert.equal(data(await srv.tools.get('reply_to_room_message').fn({ message_id: 'm1', text: 'reply' })).reply_to, 'm1');
  data(await srv.tools.get('send_room_file').fn({ path: file }));
  const received = data(await srv.tools.get('read_room_files').fn({ limit: 1 })).files[0]; assert.equal(received.sdk_file_ref, file); assert.equal(received.availability, 'available');
  assert.ok(c.calls.some(([name, args]) => name === 'getMessages' && args.limit === 1)); assert.ok(c.calls.some(([name, args]) => name === 'getFiles' && args.limit === 1));
  data(await srv.tools.get('disconnect_from_room').fn({}));
  listed = data(await srv.tools.get('list_rooms').fn({})).rooms[0]; assert.equal(listed.status, 'disconnected'); assert.equal(listed.membership_state, 'ready'); assert.equal(listed.bind_state, 'unbound');
  const srv2 = new FakeServer(); const s2 = session(c); const runtime2 = await createRuntime({ session: s2, server: srv2, registry: reg });
  assert.equal(data(await srv2.tools.get('connect_to_room').fn({ room_name: 'Room' })).status, 'connected');
  assert.equal(data(await srv2.tools.get('get_room_status').fn({})).status, 'connected');
  await runtime.shutdown(); await runtime2.shutdown();
});

test('list_rooms projects exact SDK identity session bind-state enums', async () => {
  const row = { room_name: 'Room', identity_name: 'Tutor', contact_cid: CID, membership_state: 'ready' };
  for (const [sdkSession, expected] of [['mine', 'bound_here'], ['other-live', 'bound_elsewhere'], [null, 'unbound']]) {
    const c = client({ async listIdentities() { return [{ name: 'Human', kind: 'root', session: null }, { name: 'Tutor', kind: 'role', session: sdkSession }]; } });
    const srv = new FakeServer(); await createRuntime({ session: session(c), server: srv, registry: registry([row]) });
    const projected = data(await srv.tools.get('list_rooms').fn({})).rooms[0]; assert.equal(projected.bind_state, expected); assert.equal(projected.status, expected === 'bound_here' ? 'connected' : 'disconnected');
  }
});

test('received file path is exposed only when readable by this OS user', async () => {
  const row = { room_name: 'Room', identity_name: 'Tutor', contact_cid: CID, membership_state: 'ready' };
  const c = client(); const s = session(c); s.bound = row; const srv = new FakeServer(); await createRuntime({ session: s, server: srv, registry: registry([row]) });
  const file = data(await srv.tools.get('read_room_files').fn({})).files[0]; assert.equal(file.sdk_file_ref, WIRE); assert.equal(file.availability, 'unavailable');
});

test('reply lookup paginates SDK history until the exact strict room envelope is found', async () => {
  let page = 0; const c = client({ async listHistory(v) { page += 1; return page === 1 ? { items: [{ wire_id: 'C'.repeat(64), body: 'malformed' }], next_cursor: 40 } : { items: [{ wire_id: WIRE, body: envelope }], next_cursor: null }; } });
  const row = { room_name: 'Room', identity_name: 'Tutor', contact_cid: CID, membership_state: 'ready' }; const s = session(c); s.bound = row; const srv = new FakeServer(); await createRuntime({ session: s, server: srv, registry: registry([row]) });
  data(await srv.tools.get('reply_to_room_message').fn({ message_id: 'm1', text: 'reply' })); assert.equal(page, 2);
});

test('enter cleanup and connect post-bind failures release all acquired state', async () => {
  const brokenEnter = client({ async addContact() { return { cid: CID, display: 'Room' }; } });
  const badRegistry = registry(); badRegistry.create = async () => { throw new Error('disk'); };
  const srv = new FakeServer(); await createRuntime({ session: session(brokenEnter), server: srv, registry: badRegistry });
  const entered = await srv.tools.get('enter_room').fn({ invite: 'i', as_agent: 'Tutor' }); assert.equal(entered.structuredContent.ok, false);
  assert.ok(brokenEnter.calls.some(([name]) => name === 'removeContact')); assert.ok(brokenEnter.calls.some(([name]) => name === 'removeIdentity'));
  for (const failure of ['contacts', 'promote']) {
    const row = { room_name: 'Room', identity_name: 'Tutor', contact_cid: CID, membership_state: failure === 'promote' ? 'connecting' : 'ready' };
    const c = client(failure === 'contacts' ? { async listContacts() { throw new Error('boom'); } } : {}); const reg = registry([row]); if (failure === 'promote') reg.updateState = async () => { throw new Error('boom'); };
    const s = session(c); const server = new FakeServer(); await createRuntime({ session: s, server, registry: reg });
    const out = await server.tools.get('connect_to_room').fn({ room_name: 'Room' }); assert.equal(out.structuredContent.ok, false); assert.equal(s.bound, null); assert.ok(c.calls.some(([name]) => name === 'releaseLease'));
  }
});

test('startup registry corruption fails before SDK attachment or tool mutation', async () => {
  let attached = 0; const s = { selection: { expectStateDir: '/fake' }, async ensureAttached() { attached += 1; } }; const srv = new FakeServer();
  await assert.rejects(createRuntime({ session: s, server: srv, registry: { async init() {}, async list() { throw new Error('room_registry_corrupt'); } } }), /room_registry_corrupt/);
  assert.equal(attached, 0); assert.equal(srv.tools.size, 0);
});

test('stable public errors redact SDK and filesystem details', async () => {
  const row = { room_name: 'Room', identity_name: 'Tutor', contact_cid: CID, membership_state: 'ready' };
  for (const [error, expected] of [[Object.assign(new Error('/private/file'), { code: 'FILE_TOO_LARGE' }), 'file_too_large'], [Object.assign(new Error('connect ECONNREFUSED /secret'), { code: 'ECONNREFUSED' }), 'daemon_unavailable']]) {
    const c = client({ async sendMessage() { throw error; } }); const srv = new FakeServer(); const s = session(c); s.bound = row; await createRuntime({ session: s, server: srv, registry: registry([row]) });
    const out = await srv.tools.get('send_room_message').fn({ text: 'x' }); assert.equal(out.structuredContent.error.code, expected); assert.doesNotMatch(JSON.stringify(out.structuredContent), /private|secret/);
  }
  const c = client(); const srv = new FakeServer(); const s = session(c); s.bound = row; await createRuntime({ session: s, server: srv, registry: registry([row]) });
  const out = await srv.tools.get('send_room_file').fn({ path: '/definitely/private/missing' }); assert.equal(out.structuredContent.error.code, 'file_unreadable'); assert.doesNotMatch(JSON.stringify(out.structuredContent), /definitely|private/);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-limit-')); const local = path.join(temp, 'large.bin'); await fs.writeFile(local, '1234');
  const tooLargeClient = client({ async uploadFile() { throw new Error("uploadFile(large.bin): upload is 4 bytes, at or over the transport's 3-byte envelope budget — it could not be sent even with no filename or MIME, so it is refused before it is stored"); } });
  const tooLargeSession = session(tooLargeClient); tooLargeSession.bound = row; const tooLargeServer = new FakeServer(); await createRuntime({ session: tooLargeSession, server: tooLargeServer, registry: registry([row]) });
  const limited = await tooLargeServer.tools.get('send_room_file').fn({ path: local }); assert.equal(limited.structuredContent.error.code, 'file_too_large'); assert.doesNotMatch(JSON.stringify(limited.structuredContent), /large\.bin|4 bytes|3-byte/);
  const unbound = session(client()); const unboundServer = new FakeServer(); await createRuntime({ session: unbound, server: unboundServer, registry: registry([row]) });
  for (const name of ['get_room_status', 'send_room_message', 'read_room_messages', 'reply_to_room_message', 'send_room_file', 'read_room_files']) {
    const args = name === 'send_room_message' ? { text: 'x' } : name === 'reply_to_room_message' ? { message_id: 'm', text: 'x' } : name === 'send_room_file' ? { path: '/x' } : {};
    assert.equal((await unboundServer.tools.get(name).fn(args)).structuredContent.error.code, 'not_connected');
  }
});
