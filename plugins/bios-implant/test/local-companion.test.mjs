import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readlineModule from 'node:readline';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = process.env.BIOS_IMPLANT_TEST_PACKAGE_ROOT
  ? path.resolve(process.env.BIOS_IMPLANT_TEST_PACKAGE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPANION_SOURCE = path.join(PROJECT_ROOT, 'src', 'local-companion.mjs');
const COMPANION_ENTRYPOINT = path.join('dist', 'local-mcp.mjs');

async function loadCompanionModule() {
  const nonce = `?v=${Date.now()}-${Math.random()}`;
  return import(pathToFileURL(COMPANION_SOURCE).href + nonce);
}

async function makeSandbox(t, prefix) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });
  return sandbox;
}

function setStateRoot(t, stateRoot) {
  const previous = process.env.BIOS_IMPLANT_STATE_ROOT;
  process.env.BIOS_IMPLANT_STATE_ROOT = stateRoot;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.BIOS_IMPLANT_STATE_ROOT;
    } else {
      process.env.BIOS_IMPLANT_STATE_ROOT = previous;
    }
  });
}

function biosBody(version) {
  return `---\nversion: ${version}\n---\n# demo\nBIOS v${version}\n`;
}

async function runEntrypoint(entrypoint, requests, { env = {}, clientHandlers = {} } = {}) {
  const child = spawn(process.execPath, [entrypoint], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  const messages = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));

  // The companion may issue its own client requests mid-call (roots/list during the activation
  // bind chain). Those cannot be pre-queued on stdin: they are only routable once the companion
  // has REGISTERED the pending id, which happens after its own network round-trips. So the
  // harness answers interactively, and closes stdin only once every id'd request got its
  // response — closing earlier would race the companion's in-flight work.
  const expectedIds = new Set(requests.filter((request) => 'id' in request).map((request) => request.id));
  const lineReader = readlineModule.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lineReader.on('line', (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    messages.push(message);
    if ('method' in message && 'id' in message) {
      const handler = clientHandlers[message.method];
      const response = handler
        ? { jsonrpc: '2.0', id: message.id, result: handler(message.params) }
        : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no handler for ${message.method}` } };
      child.stdin.write(`${JSON.stringify(response)}\n`);
      return;
    }
    if ('id' in message) {
      expectedIds.delete(message.id);
      if (expectedIds.size === 0) child.stdin.end();
    }
  });
  child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  if (expectedIds.size === 0) child.stdin.end();

  const [exitCode] = await once(child, 'close');
  return {
    exitCode,
    stderr: stderr.join(''),
    responses: messages,
  };
}

test('packaged local MCP entrypoint serves JSON-RPC when launched through a symlink', { concurrency: false }, async (t) => {
  const sandbox = await makeSandbox(t, 'implant-local-entrypoint-');
  const stagedPlugin = path.join(sandbox, 'staged-plugin');
  try {
    await fs.symlink(PROJECT_ROOT, stagedPlugin, 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('directory symlink creation is unavailable in this environment');
      return;
    }
    throw error;
  }

  const result = await runEntrypoint(path.join(stagedPlugin, COMPANION_ENTRYPOINT), [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.responses[0].result.serverInfo.name, 'implant-local');
  assert.deepEqual(
    result.responses[1].result.tools.map((tool) => tool.name),
    ['local_activate', 'local_connect', 'local_selection', 'local_stage', 'local_status', 'local_doctor', 'local_hello'],
  );
  const tools = Object.fromEntries(result.responses[1].result.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(tools.local_doctor.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assert.deepEqual(tools.local_selection.annotations, tools.local_doctor.annotations);
  assert.deepEqual(tools.local_activate.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});

/** Serve a well-formed setup document + activation endpoint for `agentId` on a loopback server. */
function makeActivationServer(t, agentId, capability, counters) {
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.method === 'GET' && request.url === `/setup/${capability}/SETUP.md`) {
      counters.setupReads += 1;
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      response.end(`# Agent setup\n\n\`\`\`text\nagent_id: ${agentId}\n\`\`\`\n\n\`\`\`bash\ncurl -X POST '${origin}/api/registry/activate' \\\n+  -H 'X-Enrollment-Capability: ${capability}'\n\`\`\`\n`);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/registry/activate') {
      counters.activationWrites += 1;
      counters.receivedCapability = request.headers['x-enrollment-capability'];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ agent_id: agentId, bound: true }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test('packaged local MCP performs activation over real host networking without exposing the capability', { concurrency: false }, async (t) => {
  const sandbox = await makeSandbox(t, 'implant-local-activation-');
  const stagedPlugin = path.join(sandbox, 'staged-plugin');
  await fs.symlink(PROJECT_ROOT, stagedPlugin, 'dir');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });

  const capability = 'test-capability-that-must-never-appear-in-tool-output';
  const agentId = 'agent-real-network';
  const counters = { setupReads: 0, activationWrites: 0, receivedCapability: null };
  const server = makeActivationServer(t, agentId, capability, counters);
  await once(server, 'listening');

  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await runEntrypoint(path.join(stagedPlugin, COMPANION_ENTRYPOINT), [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'local_activate',
        arguments: { setup_url: `${origin}/setup/${capability}/SETUP.md` },
      },
    },
  ], {
    env: {
      BIOS_IMPLANT_SETUP_ORIGIN: origin,
      BIOS_IMPLANT_REGISTRY_ORIGIN: origin,
      BIOS_IMPLANT_ALLOW_INSECURE_LOCAL_TEST: '1',
      BIOS_IMPLANT_STATE_ROOT: stateRoot,
    },
    // Activation chains the folder binding, which asks the client for roots/list mid-call —
    // answered here the way a real MCP host would.
    clientHandlers: {
      'roots/list': () => ({ roots: [{ uri: pathToFileURL(workspace).href, name: 'ws' }] }),
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(counters.setupReads, 1);
  assert.equal(counters.activationWrites, 1);
  assert.equal(counters.receivedCapability, capability);
  // stdout carries the server's own roots/list REQUEST too — index responses by id, requests out.
  const byId = new Map(result.responses.filter((m) => !('method' in m)).map((m) => [m.id, m]));
  const activate = byId.get(2).result;
  assert.equal(activate.isError, false);
  assert.equal(activate.structuredContent.agent_id, agentId);
  assert.equal(activate.structuredContent.registry_bound, true);
  // The trap this shape kills: a bare `bound: true` taught callers to stop before the folder
  // binding existed, with the one-use link already spent (2026-08-10).
  assert.equal('bound' in activate.structuredContent, false);
  assert.equal(activate.structuredContent.folder_bound, true);
  assert.equal(activate.structuredContent.link_spent, true);
  assert.equal(activate.structuredContent.workspace_root, await fs.realpath(workspace));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(capability));
});

test('local_activate refuses a setup document naming an unservable agent_id without spending the link', { concurrency: false }, async (t) => {
  const sandbox = await makeSandbox(t, 'implant-local-unservable-');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(stateRoot, { recursive: true });
  setStateRoot(t, stateRoot);

  const capability = 'test-capability-for-an-unservable-agent-id-document';
  // The 2026-08-10 incident id: underscores pass the mint side and 422 on every bios_load.
  const agentId = 'TVP_TEST_2-paired-2026-08';
  const counters = { setupReads: 0, activationWrites: 0, receivedCapability: null };
  const server = makeActivationServer(t, agentId, capability, counters);
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  const previousEnv = {};
  for (const [key, value] of Object.entries({
    BIOS_IMPLANT_SETUP_ORIGIN: origin,
    BIOS_IMPLANT_REGISTRY_ORIGIN: origin,
    BIOS_IMPLANT_ALLOW_INSECURE_LOCAL_TEST: '1',
  })) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const companion = await loadCompanionModule();
  const session = companion.createSession({
    listRoots: async () => [sandbox],
    output: new PassThrough(),
    error: new PassThrough(),
  });
  const response = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'local_activate',
      arguments: { setup_url: `${origin}/setup/${capability}/SETUP.md` },
    },
  });

  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.code, 'AGENT_ID_UNSERVABLE');
  assert.equal(response.result.structuredContent.details.link_spent, false);
  // Stopped BEFORE the activation request: the one-use capability was never presented.
  assert.equal(counters.activationWrites, 0);
  assert.match(response.result.content[0].text, /cannot\s+serve/);
  assert.match(response.result.content[0].text, /recreate the agent/);
});

/** Env plumbing shared by the transient-network activation tests below. */
function setActivationEnv(t, entries) {
  const previousEnv = {};
  for (const [key, value] of Object.entries(entries)) {
    previousEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function callLocalActivate(sandbox, origin, capability) {
  const companion = await loadCompanionModule();
  const session = companion.createSession({
    listRoots: async () => [sandbox],
    output: new PassThrough(),
    error: new PassThrough(),
  });
  return companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'local_activate',
      arguments: { setup_url: `${origin}/setup/${capability}/SETUP.md` },
    },
  });
}

test('local_activate absorbs one transient setup-service failure instead of surfacing it', { concurrency: false }, async (t) => {
  // The MEOW-20 shape (2026-08-11): the first fetch died on a network hiccup, the manual retry
  // 24 seconds later succeeded. That retry now lives inside the companion — the operator sees
  // one successful activation, not a scary failure whose remedy is "run it again".
  const sandbox = await makeSandbox(t, 'implant-local-retry-ok-');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(stateRoot, { recursive: true });
  setStateRoot(t, stateRoot);

  const capability = 'test-capability-transient-setup-failure-recovers';
  const agentId = 'RETRY-OK-paired-2026-08';
  const counters = { setupReads: 0, activationWrites: 0, receivedCapability: null };
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.method === 'GET' && request.url === `/setup/${capability}/SETUP.md`) {
      counters.setupReads += 1;
      if (counters.setupReads === 1) {
        request.socket.destroy(); // the transient class: reset before any response
        return;
      }
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      response.end(`# Agent setup\n\n\`\`\`text\nagent_id: ${agentId}\n\`\`\`\n\n\`\`\`bash\ncurl -X POST '${origin}/api/registry/activate' \\\n+  -H 'X-Enrollment-Capability: ${capability}'\n\`\`\`\n`);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/registry/activate') {
      counters.activationWrites += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ agent_id: agentId, bound: true }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  setActivationEnv(t, {
    BIOS_IMPLANT_SETUP_ORIGIN: origin,
    BIOS_IMPLANT_REGISTRY_ORIGIN: origin,
    BIOS_IMPLANT_ALLOW_INSECURE_LOCAL_TEST: '1',
  });

  const response = await callLocalActivate(sandbox, origin, capability);
  assert.ok(!response.result.isError, JSON.stringify(response.result));
  assert.equal(response.result.structuredContent.agent_id, agentId);
  assert.equal(counters.setupReads, 2); // the retry, not a duplicate flow
  assert.equal(counters.activationWrites, 1); // the capability was presented exactly once
});

test('a dead activation origin fails after bounded retries, naming the cause — link unspent', { concurrency: false }, async (t) => {
  const sandbox = await makeSandbox(t, 'implant-local-retry-dead-');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(stateRoot, { recursive: true });
  setStateRoot(t, stateRoot);

  // A loopback port with provably nothing listening: bind, read it, close.
  const probe = http.createServer(() => {});
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const deadOrigin = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));

  const capability = 'test-capability-dead-activation-origin-bounded-retries';
  const agentId = 'RETRY-DEAD-paired-2026-08';
  const counters = { setupReads: 0 };
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === `/setup/${capability}/SETUP.md`) {
      counters.setupReads += 1;
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      response.end(`# Agent setup\n\n\`\`\`text\nagent_id: ${agentId}\n\`\`\`\n\n\`\`\`bash\ncurl -X POST '${deadOrigin}/api/registry/activate' \\\n+  -H 'X-Enrollment-Capability: ${capability}'\n\`\`\`\n`);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  setActivationEnv(t, {
    BIOS_IMPLANT_SETUP_ORIGIN: origin,
    BIOS_IMPLANT_REGISTRY_ORIGIN: deadOrigin,
    BIOS_IMPLANT_ALLOW_INSECURE_LOCAL_TEST: '1',
  });

  const response = await callLocalActivate(sandbox, origin, capability);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.code, 'ACTIVATION_UNREACHABLE');
  assert.equal(response.result.structuredContent.details.link_spent, false);
  // The message carries what the operator needs: the concrete cause and that retries happened.
  assert.match(response.result.content[0].text, /ECONNREFUSED/);
  assert.match(response.result.content[0].text, /3 attempts/);
});

test('an activation TIMEOUT is not auto-retried and reports the link state as unknown', { concurrency: false }, async (t) => {
  // The one failure where "the link was not spent" would be a guess: the request may have
  // reached the registry with only the response lost. A blind resend of a one-use capability
  // reads back as "spent" and turns a successful activation into a reported failure — so the
  // companion must hit the endpoint EXACTLY once and route the operator to a state check.
  const sandbox = await makeSandbox(t, 'implant-local-retry-timeout-');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(stateRoot, { recursive: true });
  setStateRoot(t, stateRoot);

  const capability = 'test-capability-hanging-activation-service-no-blind-resend';
  const agentId = 'RETRY-HANG-paired-2026-08';
  const counters = { activationWrites: 0 };
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.method === 'GET' && request.url === `/setup/${capability}/SETUP.md`) {
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      response.end(`# Agent setup\n\n\`\`\`text\nagent_id: ${agentId}\n\`\`\`\n\n\`\`\`bash\ncurl -X POST '${origin}/api/registry/activate' \\\n+  -H 'X-Enrollment-Capability: ${capability}'\n\`\`\`\n`);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/registry/activate') {
      counters.activationWrites += 1;
      void response; // hold the response open — the service "hangs"
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  setActivationEnv(t, {
    BIOS_IMPLANT_SETUP_ORIGIN: origin,
    BIOS_IMPLANT_REGISTRY_ORIGIN: origin,
    BIOS_IMPLANT_ALLOW_INSECURE_LOCAL_TEST: '1',
    BIOS_IMPLANT_ACTIVATION_TIMEOUT_MS: '400',
  });

  const response = await callLocalActivate(sandbox, origin, capability);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.code, 'ACTIVATION_TIMEOUT');
  assert.equal(response.result.structuredContent.details.link_spent, null);
  assert.equal(response.result.structuredContent.details.retryable, false);
  assert.equal(counters.activationWrites, 1); // exactly one presentation — no blind resend
  assert.match(response.result.content[0].text, /MAY be spent/);
  assert.match(response.result.content[0].text, /before re-activating/);
});

test('local tool schemas and store enforce the bios-server servable alphabet', { concurrency: false }, async (t) => {
  const sandbox = await makeSandbox(t, 'implant-local-servable-');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(stateRoot, { recursive: true });
  setStateRoot(t, stateRoot);

  const companion = await loadCompanionModule();
  const session = companion.createSession({
    listRoots: async () => [sandbox],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  const tools = await companion.handleRequest(session, {
    jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
  });
  const connectTool = tools.result.tools.find((tool) => tool.name === 'local_connect');
  // The serve-side rule, byte-identical to bios-server's slug and app-v2's AGENT_ID_SERVABLE:
  // letters, digits, hyphen, 64 max. A wider pattern here binds ids bios_load will 422 forever.
  assert.equal(connectTool.inputSchema.properties.agent_id.pattern, '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$');
  assert.equal(connectTool.inputSchema.properties.label.pattern, '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$');

  const bindUnservable = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'local_connect',
      arguments: { agent_id: 'TVP_TEST_2-paired-2026-08', folder: sandbox },
    },
  });
  assert.equal(bindUnservable.result.isError, true);
  assert.equal(bindUnservable.result.structuredContent.code, 'INVALID_AGENT_ID');

  const bindServable = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'local_connect',
      arguments: { agent_id: 'TVP-TEST-3-paired-2026-08', folder: sandbox },
    },
  });
  assert.equal(bindServable.result.isError ?? false, false);
  assert.equal(bindServable.result.structuredContent.agent_id, 'TVP-TEST-3-paired-2026-08');
});

test('handleRequest advertises initialize and exactly six tools', { concurrency: false }, async () => {
  const companion = await loadCompanionModule();
  const session = companion.createSession({
    listRoots: async () => [],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  const initialize = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  const tools = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  assert.equal(initialize.result.protocolVersion, '2024-11-05');
  assert.equal(initialize.result.serverInfo.name, 'implant-local');
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    ['local_activate', 'local_connect', 'local_selection', 'local_stage', 'local_status', 'local_doctor', 'local_hello'],
  );
});

test('handleRequest stays silent on client notifications', { concurrency: false }, async () => {
  const companion = await loadCompanionModule();
  const session = companion.createSession({
    listRoots: async () => [],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  assert.equal(
    await companion.handleRequest(session, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    null,
  );
  assert.equal(
    await companion.handleRequest(session, { jsonrpc: '2.0', method: 'initialized' }),
    null,
  );
  assert.equal(
    await companion.handleRequest(session, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 9 },
    }),
    null,
  );

  const unknownRequest = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 7,
    method: 'no/such/method',
  });
  assert.equal(unknownRequest.error.code, -32601);
});

test('tools/call flows through connect, selection, stage, and status', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-mcp-');
  const workspace = path.join(sandbox, 'workspace');
  const alias = path.join(sandbox, 'workspace-link');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  try {
    await fs.symlink(workspace, alias, 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('directory symlink creation is unavailable in this environment');
      return;
    }
    throw error;
  }
  setStateRoot(t, stateRoot);

  const session = companion.createSession({
    listRoots: async () => [sandbox],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  const connect = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'local_connect',
      arguments: {
        agent_id: 'agent-mcp',
        folder: alias,
      },
    },
  });
  const selection = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'local_selection',
      arguments: {
        folder: workspace,
      },
    },
  });
  const stage = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'local_stage',
      arguments: {
        agent_id: 'agent-mcp',
        label: 'default',
        folder: workspace,
        body: biosBody(4),
        version: 4,
        etag: '"etag-4"',
      },
    },
  });
  const status = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'local_status',
      arguments: {
        folder: workspace,
      },
    },
  });

  assert.equal(connect.result.isError, false);
  assert.equal(connect.result.structuredContent.agent_id, 'agent-mcp');
  assert.equal(selection.result.isError, false);
  assert.equal(selection.result.structuredContent.workspace_root, await fs.realpath(workspace));
  assert.equal(selection.result.structuredContent.binding_path, connect.result.structuredContent.binding_path);
  assert.equal(stage.result.isError, false);
  assert.equal(stage.result.structuredContent.version, 4);
  assert.equal(
    stage.result.structuredContent.active_path,
    path.join(await fs.realpath(stateRoot), 'agents', 'agent-mcp', 'active-bios.md'),
  );
  assert.equal(status.result.isError, false);
  assert.equal(status.result.structuredContent.bios_version, 4);
  assert.equal(status.result.structuredContent.layout, 'canonical');
  assert.equal(status.result.structuredContent.bios_body, biosBody(4));
});

test('domain failures and doctor warnings are surfaced as isError results', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-errors-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const session = companion.createSession({
    listRoots: async () => [workspace],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  const doctor = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'local_doctor',
      arguments: {
        folder: workspace,
      },
    },
  });
  const mismatch = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: {
      name: 'local_stage',
      arguments: {
        agent_id: 'agent-mismatch',
        label: 'default',
        body: biosBody(1),
        version: 1,
        etag: '"etag-1"',
      },
    },
  });

  assert.equal(doctor.result.isError, false);
  assert.deepEqual(doctor.result.structuredContent.warnings, ['BINDING_REQUIRED']);
  assert.equal(mismatch.result.isError, true);
  assert.equal(mismatch.result.structuredContent.code, 'BINDING_REQUIRED');
});

test('local_doctor reports damaged bindings as unhealthy errors without leaking payloads', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-doctor-binding-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const session = companion.createSession({
    listRoots: async () => [workspace],
    output: new PassThrough(),
    error: new PassThrough(),
  });
  const connect = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'local_connect',
      arguments: { agent_id: 'agent-broken-binding' },
    },
  });
  const malformedSecret = 'secret-binding-fragment';
  await fs.writeFile(
    connect.result.structuredContent.binding_path,
    `{broken:${malformedSecret}`,
    'utf8',
  );

  const doctor = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: {
      name: 'local_doctor',
      arguments: { folder: workspace },
    },
  });
  const selection = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: {
      name: 'local_selection',
      arguments: { folder: workspace },
    },
  });

  assert.equal(doctor.result.isError, true);
  assert.equal(doctor.result.structuredContent.healthy, false);
  assert.deepEqual(doctor.result.structuredContent.errors, ['BINDING_UNREADABLE']);
  assert.deepEqual(doctor.result.structuredContent.warnings, []);
  assert.equal(doctor.result.content[0].text.includes('Unhealthy'), true);
  assert.equal(JSON.stringify(doctor.result).includes(malformedSecret), false);
  assert.equal(selection.result.isError, true);
  assert.equal(selection.result.structuredContent.code, 'BINDING_UNREADABLE');
  assert.equal(JSON.stringify(selection.result).includes(malformedSecret), false);
});

test('server-initiated roots/list requests time out and resolved requests clear their timers', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-roots-timeout-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'missing-state');
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const output = new PassThrough();
  const outputChunks = [];
  output.on('data', (chunk) => outputChunks.push(chunk.toString('utf8')));
  const session = companion.createSession({
    output,
    error: new PassThrough(),
    clientRequestTimeoutMs: 25,
  });

  const resolvedRequest = session.callClient('roots/list', {});
  const firstRequest = JSON.parse(outputChunks.join('').trim().split('\n')[0]);
  assert.equal(session.resolveClientResponse({
    jsonrpc: '2.0',
    id: firstRequest.id,
    result: { roots: [workspace] },
  }), true);
  assert.deepEqual(await resolvedRequest, { roots: [workspace] });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(session.resolveClientResponse({
    jsonrpc: '2.0',
    id: firstRequest.id,
    result: { roots: [] },
  }), false);

  const timedOut = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: {
      name: 'local_selection',
      arguments: { folder: workspace },
    },
  });

  assert.equal(timedOut.result.isError, true);
  assert.equal(timedOut.result.structuredContent.code, 'CLIENT_REQUEST_TIMEOUT');
  await assert.rejects(fs.access(stateRoot), (error) => error?.code === 'ENOENT');
});

test('local_doctor keeps staged BIOS bodies out of text and structured content', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-doctor-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'state');
  const secretBody = 'secret fallback body';
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const session = companion.createSession({
    listRoots: async () => [workspace],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: {
      name: 'local_connect',
      arguments: { agent_id: 'agent-doctor' },
    },
  });
  await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'local_stage',
      arguments: {
        agent_id: 'agent-doctor',
        label: 'default',
        body: secretBody,
        version: 2,
        etag: '"etag-doctor"',
      },
    },
  });

  const doctor = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'local_doctor',
      arguments: {
        folder: workspace,
      },
    },
  });

  assert.equal(doctor.result.isError, false);
  assert.equal(doctor.result.content[0].text.includes(secretBody), false);
  assert.equal(JSON.stringify(doctor.result.structuredContent).includes(secretBody), false);
});

test('local_stage accepts folder when multiple workspace roots are granted', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-multiroot-');
  const workspaceOne = path.join(sandbox, 'workspace-one');
  const workspaceTwo = path.join(sandbox, 'workspace-two');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspaceOne, { recursive: true });
  await fs.mkdir(workspaceTwo, { recursive: true });
  setStateRoot(t, stateRoot);

  const session = companion.createSession({
    listRoots: async () => [workspaceOne, workspaceTwo],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: {
      name: 'local_connect',
      arguments: {
        agent_id: 'agent-multi',
        folder: workspaceTwo,
      },
    },
  });

  const stage = await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 13,
    method: 'tools/call',
    params: {
      name: 'local_stage',
      arguments: {
        agent_id: 'agent-multi',
        label: 'default',
        folder: workspaceTwo,
        body: biosBody(6),
        version: 6,
        etag: '"etag-multi"',
      },
    },
  });

  assert.equal(stage.result.isError, false);
  assert.equal(stage.result.structuredContent.workspace_root, await fs.realpath(workspaceTwo));
  assert.equal(stage.result.structuredContent.version, 6);
});

test('runStdio emits newline-delimited json-rpc responses', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-stdio-');
  const workspace = path.join(sandbox, 'workspace');
  await fs.mkdir(workspace, { recursive: true });

  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')));

  const runPromise = companion.runStdio({
    input,
    output,
    error,
    listRoots: async () => [workspace],
  });

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping', params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} })}\n`);
  input.end();

  const exitCode = await runPromise;
  const lines = chunks.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

  assert.equal(exitCode, 0);
  assert.equal(lines[0].id, 11);
  assert.deepEqual(lines[0].result, {});
  assert.equal(lines[1].id, 12);
  assert.equal(lines[1].result.tools.length, 7);
});

test('local_hello answers the liveness challenge from live state', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-hello-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const session = companion.createSession({
    listRoots: async () => [workspace],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  const hello = (id) => companion.handleRequest(session, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'local_hello', arguments: { folder: workspace } },
  });

  // Cold: the companion is running but nothing is bound. It must still answer — being
  // reachable is the thing being proven — without claiming a binding it does not have.
  const cold = await hello(1);
  assert.equal(cold.result.isError, false);
  assert.equal(cold.result.structuredContent.greeting, "Hey there! I'm a hat, an implant on a head.");
  assert.equal(cold.result.structuredContent.alive, true);
  assert.equal(cold.result.structuredContent.bound, false);
  assert.equal(cold.result.structuredContent.staged, false);
  assert.match(cold.result.content[0].text, /no folder bound yet/);
  // Four-state ladder — glanceable installed/bound/authorized/booted, cold state.
  assert.match(cold.result.content[0].text, /installed\s+\[x\]/);
  assert.match(cold.result.content[0].text, /bound\s+\[ \] no folder bound yet/);
  assert.match(cold.result.content[0].text, /authorized\s+\[\?\].*doctor/);
  assert.match(cold.result.content[0].text, /booted\s+\[ \] no BIOS staged/);

  await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'local_connect',
      arguments: { agent_id: 'hello-agent', label: 'default', folder: workspace },
    },
  });
  await companion.handleRequest(session, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'local_stage',
      arguments: {
        agent_id: 'hello-agent',
        label: 'default',
        body: biosBody(4),
        version: 4,
        etag: '"etag-4"',
      },
    },
  });

  const warm = await hello(4);
  const structured = warm.result.structuredContent;
  assert.equal(warm.result.isError, false);
  assert.equal(structured.bound, true);
  assert.equal(structured.staged, true);
  assert.equal(structured.agent_id, 'hello-agent');
  assert.equal(structured.label, 'default');
  assert.equal(structured.bios_version, 4);
  assert.equal(structured.workspace_root, await fs.realpath(workspace));

  // The evidence must live in the sentence the human reads, not only in the structured
  // payload — a model that merely memorised the greeting cannot invent these.
  const text = warm.result.content[0].text;
  assert.match(text, /^Hey there! I'm a hat, an implant on a head\./);
  assert.match(text, /hello-agent\/default/);
  assert.match(text, /BIOS v4/);
  // Four-state ladder, warm state — the same facts, now as a status ladder.
  assert.match(text, /installed\s+\[x\] .*implant/);
  assert.match(text, /bound\s+\[x\] hello-agent\/default/);
  assert.match(text, /authorized\s+\[\?\].*8hats-implant-doctor/);
  assert.match(text, /booted\s+\[x\] BIOS v4/);
});

test('local_hello is read-only and never mutates the store', { concurrency: false }, async (t) => {
  const companion = await loadCompanionModule();
  const sandbox = await makeSandbox(t, 'implant-local-hello-ro-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const session = companion.createSession({
    listRoots: async () => [workspace],
    output: new PassThrough(),
    error: new PassThrough(),
  });

  const listed = await companion.handleRequest(session, {
    jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
  });
  const tool = listed.result.tools.find((entry) => entry.name === 'local_hello');
  assert.ok(tool, 'local_hello must be advertised');
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  const before = await fs.readdir(stateRoot).catch(() => []);
  await companion.handleRequest(session, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'local_hello', arguments: { folder: workspace } },
  });
  const after = await fs.readdir(stateRoot).catch(() => []);
  assert.deepEqual(after, before);
});
