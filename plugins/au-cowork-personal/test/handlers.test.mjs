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
    async currentIdentity() { return {name:'Tutor',cid:'C'.repeat(64)}; }, async listIdentities() { return [{ name: 'Human', kind: 'root', session: null }, ...(roleExists ? [{ name: 'Tutor', kind: 'role', session: roleSession }] : [])]; }, async createIdentity(v) { calls.push(['createIdentity', v]); roleExists = true; roleSession = 'mine'; },
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
function session(c) { return { connections:{list:async()=>[]}, selection: { expectStateDir: '/fake' }, client: c, bound: null, async ensureAttached() { return this.client; }, async release() { this.bound = null; await c.releaseLease(); } }; }
const data = (result) => { assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent)); return result.structuredContent.data; };

test('five session handlers retain enter/reconnect/disconnect lifecycle', async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-handler-')); const file = path.join(source, 'a.txt'); await fs.writeFile(file, 'ok');
  const c = client(); c.getFiles = async (v) => { c.calls.push(['getFiles', v]); return { files: [{ wire_id: WIRE, from: { id: CID }, filename: 'a.txt', mime: 'text/plain', size: 2, date: 'now', path: file }], remaining: 0 }; }; const s = session(c); const srv = new FakeServer(); const reg = registry(); const runtime = await createRuntime({ session: s, server: srv, registry: reg });
  assert.equal(srv.tools.size, 22);
  data(await srv.tools.get('enter_room').fn({ invite: 'invite', as_agent: 'Tutor' }));
  let listed = data(await srv.tools.get('list_rooms').fn({})).rooms[0]; assert.equal(listed.status, 'connected'); assert.equal(listed.membership_state, 'ready'); assert.equal(listed.bind_state, 'bound_here');
  assert.equal(data(await srv.tools.get('get_room_status').fn({})).status, 'connected');
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

test('session tools reject unbound status and redact SDK failures',async()=>{
 const c=client({async listContacts(){throw Error('/private/secret');}}),srv=new FakeServer(),s=session(c);await createRuntime({session:s,server:srv,registry:registry()});
 assert.equal((await srv.tools.get('get_room_status').fn({})).structuredContent.error.code,'not_connected');
 s.bound={room_name:'Room',identity_name:'Tutor',contact_cid:CID,membership_state:'ready'};
 const result=await srv.tools.get('get_room_status').fn({});assert.equal(result.structuredContent.ok,false);assert.doesNotMatch(JSON.stringify(result),/private|secret/);
});

// An unmapped error collapses to `internal_error`, whose message tells the caller to "use
// request_id for diagnostics" -- while that id was written nowhere at all. Three separate people
// resorted to patching the shipped bundle to see through it. The correlation now goes to the
// operator's stderr; the client payload must stay opaque, because PUBLIC_CODES is an allowlist.
// Note what stderr is NOT: an MCP client can read it (StdioClientTransport takes a `stderr` option
// and dist-smoke.mjs uses it). The guarantee is that it stays out of the TOOL RESULT, so it never
// reaches the model's context and cannot be relayed onward by an agent.
test('an unmapped failure correlates its request_id on stderr without leaking detail to the client', async () => {
  const c = client(); const s = session(c); const srv = new FakeServer();
  const secret = 'C:\\Users\\someone\\private-token-path';
  const reg = registry();
  const runtime = await createRuntime({ session: s, server: srv, registry: reg });
  reg.list = async () => { throw Object.assign(new Error(`bespoke failure at ${secret}`), { code: 'not_a_public_code' }); };
  const written = []; const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  let result; try { result = await srv.tools.get('list_rooms').fn({}); } finally { process.stderr.write = real; }

  const payload = result.structuredContent;
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'internal_error');
  assert.ok(!JSON.stringify(payload).includes(secret), 'client payload must not carry internal detail');
  assert.ok(!JSON.stringify(payload).includes('not_a_public_code'), 'client payload must not carry the unmapped code');

  const line = written.map((w) => w.trim()).find((w) => w.includes('"event":"internal_error"'));
  assert.ok(line, `expected an internal_error diagnostic on stderr, got: ${JSON.stringify(written)}`);
  const logged = JSON.parse(line);
  assert.equal(logged.request_id, payload.request_id, 'stderr must correlate with the id handed to the client');
  assert.equal(logged.code, 'not_a_public_code', 'stderr must carry the real code');
  assert.ok(logged.message.includes(secret), 'the diagnostic channel carries the detail the client is denied');
});

test('identity_in_use is retryable and its action warns against force-rebind', async () => {
  // F1 regression guard. A session that dies without disconnecting leaves the daemon holding the
  // lease, and it clears on its own. Reporting retryable:false told callers to stop for good, which
  // sent one agent hunting for an escape and into a force-rebind that PERMANENTLY destroyed the
  // identity (it loses its room contact and no tool can restore one). Waiting is the only safe exit.
  const c = client({ chooseIdentity: async () => { throw Object.assign(new Error('bound'), { code: 'BOUND_ELSEWHERE' }); } });
  const srv = new FakeServer();
  await createRuntime({ session: session(c), server: srv, registry: registry([{ room_name: 'Room', identity_name: 'Tutor', contact_cid: CID, membership_state: 'ready' }]) });
  const out = (await srv.tools.get('connect_to_room').fn({ room_name: 'Room' })).structuredContent;
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'identity_in_use');
  assert.equal(out.error.retryable, true, 'identity_in_use is transient — reporting it unretryable causes the force-rebind trap');
  assert.match(out.error.action ?? '', /wait/i);
  assert.match(out.error.action ?? '', /force/i, 'the action must warn against force-rebind');
});

test('widening retryable does not make unrelated codes retryable', async () => {
  // Guards the F1 widening itself: adding one code must not flip the default for every other.
  const srv = new FakeServer();
  await createRuntime({ session: session(client()), server: srv, registry: registry() });
  const out = (await srv.tools.get('connect_to_room').fn({ room_name: 'Nope' })).structuredContent;
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'room_not_found');
  assert.equal(out.error.retryable, false, 'unrelated codes must stay non-retryable');
  assert.equal(out.error.action, undefined, 'codes without an action must not gain one');
});
