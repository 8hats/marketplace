import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createCoordinator, stateDirectory } from '../harness/index.js';
import { createRuntime, ConnectionStore } from '../src/server.mjs';
import { CentralClient as Personal, networkCategory } from '../src/central-client.mjs';
import { CentralClient as Moderator } from '../../au-cowork-moderator/src/central-client.mjs';

// Room watch health stays calm: a short retry is silent, a sustained outage is reported once with a
// safe category, and recovery after that report is announced once. Nothing secret reaches a notice.
const id = '11111111-1111-4111-8111-111111111111';
const origin = 'https://cowork.example';
const credential = 'a'.repeat(43);
const secret = 'DO_NOT_ECHO_RAW_ERROR_' + 'x'.repeat(8);
const row = { version: 1, connection_id: id, credential, origin, room_name: 'Room', room_id: 'room', agent_id: 'agent',
  display_name: 'Agent', expires_at: '2099-01-01T00:00:00.000Z', cursor: 0, staged: [], consumed_files: [], watch_enabled: true };
const fetchFailure = (code, message = secret) => new TypeError('fetch failed ' + secret, { cause: Object.assign(new Error(message + ' ' + origin), { code }) });
const page = () => new Response(JSON.stringify({ data: { events: [], cursor: 0 } }), { headers: { 'content-type': 'application/json' } });
const forbidden = [credential, secret, origin, 'cowork.example', 'Bearer', 'fetch failed'];
const clean = value => { const text = JSON.stringify(value); for (const word of forbidden) assert.equal(text.includes(word), false, `leaked ${word}`); };

for (const [profile, Client] of [['Personal', Personal], ['Moderator', Moderator]]) {
  test(`${profile}: a failed fetch keeps a fixed category and never its message, host or credential`, async () => {
    for (const [code, category] of [['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ETIMEDOUT', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
      ['ECONNREFUSED', 'refused'], ['ECONNRESET', 'reset'], ['UND_ERR_SOCKET', 'reset'], ['CERT_HAS_EXPIRED', 'tls'],
      ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['EHOSTUNREACH', 'network'], [undefined, 'network']]) {
      const client = new Client({ store: { async save() {}, async release() {} }, origin, fetchFn: async () => { throw fetchFailure(code); } });
      client.row = { ...row };
      await assert.rejects(() => client.request('/events?after=0'), error => {
        assert.equal(error.code, 'central_unavailable');
        assert.equal(error.diagnostic.reason, 'network_error');
        assert.equal(error.diagnostic.category, category, String(code));
        clean(error.diagnostic);
        return true;
      });
    }
  });
}

test('an aborted or timed-out fetch is categorised as timeout', () => {
  assert.equal(networkCategory(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'timeout');
  assert.equal(networkCategory(new TypeError('fetch failed'), true), 'timeout');
  assert.equal(networkCategory(new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error(), { code: 'ECONNREFUSED' })]) })), 'refused');
  assert.equal(networkCategory(null), 'network');
});

// The real runtime and client inside the Host adapter, driven by a scripted transport and a virtual clock.
async function harness(t, script) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'cowork-calm-health-'));
  const agent = { id: 'chat', messages: [], async steer(message) { this.messages.push(message); } };
  await new ConnectionStore(stateDirectory(root, agent.id)).save({ ...row });
  let clock = Date.parse('2026-01-01T00:00:00Z'), polls = 0;
  const fetchFn = async (url, options) => {
    if (!url.includes('/events')) throw new Error('unexpected route');
    const step = script[polls++];
    if (!step) return delay(100000, undefined, { signal: options.signal });
    if (step.ms) clock += step.ms;
    // A real successful long poll holds open, so the watch stays live for a while.
    if (step.wait) await delay(step.wait);
    if (step.ok) return page();
    throw fetchFailure(step.code);
  };
  // Each retry advances the virtual clock by its backoff; the real wait lets the adapter observe the state.
  const retryDelayFn = (ms, value, options) => { clock += ms; return delay(15, value, options); };
  const tools = new Map();
  const ctx = { agents: { get: key => key === agent.id ? agent : undefined, withoutInitiator: fn => fn() } };
  const coordinator = createCoordinator(ctx, { stateRoot: root, origin }, {
    now: () => clock, healthCheckMs: 5,
    loadModules: async () => ({
      ConnectionStore,
      createRuntime: options => createRuntime({ ...options, clientOptions: { ...options.clientOptions, fetchFn, retryDelayFn } }),
      createScope: () => ({ ctx: { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } }, async dispose() {} }),
    }),
  });
  t.after(async () => { await coordinator.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await coordinator.attach(agent);
  const notices = () => agent.messages.map(message => message.content[0].text);
  const status = async () => (await tools.get('mcp__au-cowork__get_watch_status').execute({}, { signal: new AbortController().signal })).structuredContent;
  const settled = async () => { while (polls <= script.length) await delay(5); await delay(60); };
  return { agent, notices, status, settled, polls: () => polls };
}
const fail = (code = 'ECONNRESET', ms = 0, wait = 0) => ({ code, ms, wait });

test('a short VPN-style interruption (3 failures, then success) produces no notice', async t => {
  const h = await harness(t, [fail(), fail(), fail(), { ok: true }]);
  await h.settled();
  assert.deepEqual(h.notices(), []);
  const health = (await h.status()).data.health;
  assert.equal(health.live, true); assert.equal(health.consecutive_failures, 0);
});

test('a sustained outage notifies unavailable once with its category, then recovery once', async t => {
  const h = await harness(t, [...Array.from({ length: 8 }, () => fail('ENOTFOUND')), { ok: true }]);
  await h.settled();
  const notices = h.notices();
  assert.equal(notices.length, 2, JSON.stringify(notices));
  assert.match(notices[0], /^Cowork monitoring is unavailable \(category: dns; [5-8] consecutive failures over \d+ s; still retrying\)\./);
  assert.match(notices[1], /^Cowork monitoring recovered after \d+ s\./);
  for (const notice of notices) clean(notice);
  const status = await h.status();
  clean(status);
  assert.equal(status.data.health.live, true);
});

test('more than 30 s of failure notifies once even with fewer than 5 failures', async t => {
  // Each attempt hangs for 20 s before failing, as a connect timeout would.
  const h = await harness(t, [fail('UND_ERR_CONNECT_TIMEOUT', 20000), fail('UND_ERR_CONNECT_TIMEOUT', 20000), fail('UND_ERR_CONNECT_TIMEOUT', 20000)]);
  await h.settled();
  const notices = h.notices();
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.match(notices[0], /^Cowork monitoring is unavailable \(category: timeout; [2-3] consecutive failures over \d+ s; still retrying\)\./);
  const status = await h.status();
  assert.equal(status.data.health.live, false); assert.equal(status.data.health.diagnostic.category, 'timeout');
  clean(notices); clean(status);
});

test('a later second outage is reported again after a recovery', async t => {
  const h = await harness(t, [...Array.from({ length: 6 }, () => fail('ECONNREFUSED')), { ok: true },
    fail('ECONNREFUSED', 0, 60), ...Array.from({ length: 5 }, () => fail('ECONNREFUSED')), { ok: true }]);
  await h.settled();
  const notices = h.notices();
  assert.equal(notices.length, 4, JSON.stringify(notices));
  assert.deepEqual(notices.map(text => /unavailable \(category: refused/.test(text) ? 'down' : /recovered after/.test(text) ? 'up' : text), ['down', 'up', 'down', 'up']);
});
