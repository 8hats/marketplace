import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createCoordinator, stateDirectory, CoworkToolError } from '../harness/index.js';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime, CentralClient, ConnectionStore } from '../src/server.mjs';

test('copied Host package loads its own bundled runtime without a parent checkout', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cowork-host-install-'));
  const installed = path.join(root, 'installed'), tools = new Map();
  await cp(new URL('../harness/', import.meta.url), installed, { recursive: true });
  const { createCoordinator: installedCoordinator } = await import(pathToFileURL(path.join(installed, 'index.js')).href);
  const agent = { id: 'isolated-package', steer() { throw Error('An empty store must not wake'); } };
  agent.ctx = { get: name => name === 'tools' ? { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } } : undefined };
  const ctx = { agents: { get: () => agent, withoutInitiator: fn => fn() }, tools: { register() { throw Error('Must not register globally'); } } };
  const coordinator = installedCoordinator(ctx, { stateRoot: path.join(root, 'state') });
  try {
    await coordinator.attach(agent);
    assert.ok(tools.has('mcp__au-cowork__connect_to_room'));
    const status = await tools.get('mcp__au-cowork__get_watch_status').execute({}, { signal: new AbortController().signal });
    assert.equal(status.structuredContent.host_watch.session_id, agent.id);
    assert.equal(status.structuredContent.data.watch_enabled, false);
  } finally { await coordinator.dispose(); await rm(root, { recursive: true, force: true }); }
});

function fixture(options = {}) {
  const live = new Map(), scopes = new Map(), runtimes = [];
  const ctx = { agents: { get: id => live.get(id), withoutInitiator: fn => fn() } };
  const deps = { loadModules: async () => ({
    ConnectionStore: class { constructor(root) { this.root = root; } },
    createScope(_ctx, agent) {
      const tools = new Map();
      const scope = { tools, disposed: false, ctx: { tools: { register(tool) {
        if (tools.has(tool.name)) throw new Error('duplicate');
        tools.set(tool.name, tool); return () => tools.delete(tool.name);
      } } }, async dispose() { this.disposed = true; tools.clear(); } };
      scopes.set(agent, scope); return scope;
    },
    async createRuntime({ injectedServer: server, clientOptions }) {
      const runtime = { server, client: { store: clientOptions.store, monitorState: 'running',
        row: { agent_id: 'self', watch_enabled: true },
        request: async (route, opts) => options.lookup ? options.lookup(route, opts) : { author: { id: route.endsWith('/own') ? 'self' : 'other' } } },
        shutdowns: 0, async shutdown() { this.shutdowns++; } };
      runtimes.push(runtime);
      server.registerTool('sample', { inputSchema: 'passthrough' }, async (args, extra) => {
        runtime.signal = extra.signal;
        if (options.toolRun) await options.toolRun(runtime);
        return args.fail ? { isError: true, structuredContent: { error: { code: 'forbidden', message: 'denied' } } } : { structuredContent: { ok: true } };
      });
      server.server.setRequestHandler({ method: 'tools/list' }, async () => ({ tools: [{ name: 'sample', description: 'sample', inputSchema: { type: 'object', properties: { fail: { type: 'boolean' } }, additionalProperties: false } }] }));
      if (options.initial) await server.sendLoggingMessage({ data: options.initial });
      if (options.startup) await options.startup(runtime);
      return runtime;
    },
  }) };
  const coordinator = createCoordinator(ctx, { stateRoot: '/tmp/cowork-adapter-test', coalesceMs: 100, retryMs: 250 }, deps);
  function agent(id) { const messages = []; const value = { id, messages, async steer(message) { messages.push(message); } }; live.set(id, value); return value; }
  const event = (id, kind = 'message', resourceId = id) => ({ status: 'event', event: { event_id: id, resource: { kind, id: resourceId } } });
  return { coordinator, scopes, runtimes, live, agent, event, deps, ctx };
}

test('exact sha256 session isolation, actual listing schemas, structured result/error and safe diagnostics', async () => {
  const f = fixture(), a = f.agent('chat'), b = f.agent('fork');
  try {
    await Promise.all([f.coordinator.attach(a), f.coordinator.attach(b)]);
    assert.equal(f.runtimes[0].client.store.root, stateDirectory('/tmp/cowork-adapter-test', 'chat'));
    assert.notEqual(f.runtimes[0].client.store.root, f.runtimes[1].client.store.root);
    assert.equal(stateDirectory('/tmp', 'chat'), path.join('/tmp', createHash('sha256').update('chat').digest('hex')));
    const tool = f.scopes.get(a).tools.get('mcp__au-cowork__sample');
    assert.equal(tool.parameters.additionalProperties, false);
    const result = await tool.execute({}, { signal: new AbortController().signal });
    assert.deepEqual(result, { structuredContent: { ok: true } });
    assert.equal(tool.output.render({}, result)[0].text, JSON.stringify(result));
    await assert.rejects(tool.execute({ fail: true }, { signal: new AbortController().signal }), error => error instanceof CoworkToolError && error.code === 'forbidden');
    const status = await f.scopes.get(a).tools.get('mcp__au-cowork__get_watch_status').execute();
    assert.equal(status.session_id, 'chat'); assert.equal(status.state_root_fingerprint.length, 64);
    assert.equal(JSON.stringify(status).includes('/tmp'), false);
  } finally { await f.coordinator.dispose(); }
  assert.ok([...f.scopes.values()].every(scope => scope.disposed && scope.tools.size === 0));
});

test('coalesces initial hints, bounded dedupe, suppresses own messages, ignores nonexternal resources', async () => {
  const initial = { status: 'event', event: { event_id: 'first', resource: { kind: 'attachment', id: 'file' } } };
  const f = fixture({ initial }), a = f.agent('chat');
  try {
    await f.coordinator.attach(a);
    const server = f.runtimes[0].server;
    for (const data of [f.event('own'), f.event('ext'), f.event('ext'), f.event('cmd', 'command'), f.event('room', 'room')]) await server.sendLoggingMessage({ data });
    await delay(180);
    assert.equal(a.messages.length, 1);
    assert.equal(a.messages[0].source.kind, 'plugin');
    assert.equal(a.messages[0].source.form, 'notice');
    assert.match(a.messages[0].content[0].text, /first/);
    assert.doesNotMatch(a.messages[0].content[0].text, /"own"|"room"/);
    await server.sendLoggingMessage({ data: f.event('ext') }); await delay(160);
    assert.equal(a.messages.length, 1);
    for (let i = 0; i < 5100; i++) await server.sendLoggingMessage({ data: f.event('bulk' + i, 'attachment') });
    const status = await f.scopes.get(a).tools.get('mcp__au-cowork__get_watch_status').execute();
    assert.equal(status.pending_count, 5000);
  } finally { await f.coordinator.dispose(); }
});

test('transient author lookup remains pending and retries without consuming or mutation', async () => {
  let calls = 0;
  const f = fixture({ lookup: async route => {
    assert.equal(route, '/messages/ext');
    if (++calls === 1) throw Object.assign(new Error(), { code: 'central_unavailable' });
    return { author: { id: 'other' } };
  } }), a = f.agent('chat');
  try {
    await f.coordinator.attach(a);
    await f.runtimes[0].server.sendLoggingMessage({ data: f.event('ext') });
    await delay(180); assert.equal(a.messages.length, 0);
    assert.equal((await f.scopes.get(a).tools.get('mcp__au-cowork__get_watch_status').execute()).pending_count, 1);
    await delay(300); assert.equal(a.messages.length, 1); assert.equal(calls, 2);
  } finally { await f.coordinator.dispose(); }
});

test('disposal awaits asynchronous lookup and prevents late wake; exact liveness rejects replacement', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ lookup: async () => { entered(); return new Promise(resolve => { release = resolve; }); } }), a = f.agent('chat');
  await f.coordinator.attach(a);
  await f.runtimes[0].server.sendLoggingMessage({ data: f.event('ext') });
  await started;
  const disposing = f.coordinator.detach(a);
  release({ author: { id: 'other' } }); await disposing;
  assert.equal(a.messages.length, 0); assert.equal(f.runtimes[0].shutdowns, 1);
  const b = f.agent('chat'); await f.coordinator.attach(b);
  f.live.set('chat', { id: 'chat' });
  await f.runtimes[1].server.sendLoggingMessage({ data: f.event('another', 'attachment') });
  await delay(160); assert.equal(b.messages.length, 0);
  await f.coordinator.dispose();
});

test('unavailable/reconnecting warning is once and startup failure cleans partial scope', async () => {
  const f = fixture(), a = f.agent('chat');
  try {
    await f.coordinator.attach(a);
    await f.runtimes[0].server.sendLoggingMessage({ data: { status: 'unavailable' } });
    await f.runtimes[0].server.sendLoggingMessage({ data: { status: 'reconnecting' } });
    assert.equal(a.messages.length, 1);
  } finally { await f.coordinator.dispose(); }
  const bad = fixture({ startup: async () => { throw new Error('startup failed'); } }), b = bad.agent('bad');
  await assert.rejects(bad.coordinator.attach(b), /startup failed/);
  assert.equal(b.messages.length, 1); assert.equal(bad.scopes.get(b).disposed, true);
  await bad.coordinator.dispose();
});

test('missing module warns and leaves no registrations; disposal during startup shuts down late runtime', async () => {
  const f = fixture(), a = f.agent('missing');
  const missing = createCoordinator(f.ctx, {}, { loadModules: async () => { throw new Error('module missing'); } });
  await assert.rejects(missing.attach(a), /module missing/); assert.equal(a.messages.length, 1); assert.equal(f.scopes.size, 0);
  await missing.dispose();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const late = fixture({ startup: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
  const b = late.agent('late');
  const attaching = late.coordinator.attach(b); await started;
  const detaching = late.coordinator.detach(b); release();
  await Promise.all([attaching, detaching]);
  assert.equal(late.runtimes[0].shutdowns, 1); assert.equal(late.scopes.get(b).tools.size, 0);
  assert.equal(b.messages.length, 0); await late.coordinator.dispose();
});

test('teardown drains a started mutation before releasing its runtime binding', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ toolRun: async runtime => {
    entered(); await new Promise(resolve => { release = resolve; });
    assert.equal(runtime.shutdowns, 0, 'binding must remain owned while mutation response settles');
  } }), a = f.agent('mutation');
  await f.coordinator.attach(a);
  const executing = f.scopes.get(a).tools.get('mcp__au-cowork__sample').execute({}, { signal: new AbortController().signal });
  await started;
  const disposed = f.coordinator.detach(a);
  release(); await Promise.all([executing, disposed]);
  assert.equal(f.runtimes[0].shutdowns, 1);
  await f.coordinator.dispose();
});

test('real marketplace runtime supplies strict model schemas and preserves environment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cowork-adapter-real-'));
  const before = { ...process.env }, f = fixture(), a = f.agent('real');
  const factories = await f.deps.loadModules();
  const coordinator = createCoordinator(f.ctx, { stateRoot: root }, { loadModules: async () => ({ ...factories, createRuntime, CentralClient, ConnectionStore }) });
  try {
    await coordinator.attach(a);
    const scope = f.scopes.get(a);
    const tool = scope.tools.get('mcp__au-cowork__enter_room');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(tool.parameters.required.includes('invite'));
    await assert.rejects(tool.execute({}, { signal: new AbortController().signal }), error => error.code === 'invalid_request');
    const status = await scope.tools.get('mcp__au-cowork__get_watch_status').execute({}, { signal: new AbortController().signal });
    assert.equal(status.structuredContent.host_watch.watch_enabled, false);
    assert.equal(status.structuredContent.host_watch.session_id, 'real');
    assert.deepEqual({ ...process.env }, before);
  } finally { await coordinator.dispose(); await rm(root, { recursive: true, force: true }); }
});
