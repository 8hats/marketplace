import readline from 'node:readline';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  localConnect,
  localDoctor,
  localSelection,
  localStage,
  localStatus,
  DomainError,
} from './store.mjs';
import {
  DEFAULT_LABEL,
  LOCAL_MCP_PROTOCOL_VERSION,
  LOCAL_MCP_SERVER_NAME,
  LOCAL_MCP_SERVER_VERSION,
} from './constants.mjs';
import { safeErrorMessage } from './util.mjs';

const PROTOCOL_VERSION = LOCAL_MCP_PROTOCOL_VERSION ?? '2024-11-05';
const SERVER_NAME = LOCAL_MCP_SERVER_NAME ?? 'implant-local';
const SERVER_VERSION = LOCAL_MCP_SERVER_VERSION ?? '1.0.15';
const DEFAULT_BINDING_LABEL = DEFAULT_LABEL ?? 'default';
export const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_SETUP_ORIGIN = 'https://app.agents.university';
const DEFAULT_REGISTRY_ORIGIN = 'https://registry.agents.university';
const ACTIVATION_TIMEOUT_MS = 10_000;
const MAX_ACTIVATION_RESPONSE_BYTES = 64 * 1024;

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const LOCAL_WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const ACTIVATION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
});

const TOOL_DEFINITIONS = [
  {
    name: 'local_activate',
    description: 'Use an owner-provided one-use Agent University setup URL to perform the single activation request from the native host.',
    annotations: ACTIVATION_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['setup_url'],
      properties: {
        setup_url: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    name: 'local_connect',
    description: 'Bind the current workspace root or descendant to an agent id and label in the local store.',
    annotations: LOCAL_WRITE_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' },
        label: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$', default: DEFAULT_BINDING_LABEL },
        folder: { type: 'string' },
      },
    },
  },
  {
    name: 'local_selection',
    description: 'Return the current folder binding for a granted workspace root.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        folder: { type: 'string' },
      },
    },
  },
  {
    name: 'local_stage',
    description: 'Stage BIOS content for the currently bound agent and label with monotonic version checks.',
    annotations: LOCAL_WRITE_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['agent_id', 'label', 'body', 'version', 'etag'],
      properties: {
        agent_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' },
        label: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$' },
        body: { type: 'string' },
        version: { type: 'integer', minimum: 0 },
        etag: { type: 'string', minLength: 1 },
        folder: { type: 'string' },
      },
    },
  },
  {
    name: 'local_status',
    description: 'Inspect staged BIOS status for the bound agent or an explicit agent id and label.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$' },
        label: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$', default: DEFAULT_BINDING_LABEL },
        folder: { type: 'string' },
      },
    },
  },
  {
    name: 'local_doctor',
    description: 'Report local store safety, folder binding, staged BIOS availability, and warnings.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        folder: { type: 'string' },
      },
    },
  },
];

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function parseConfiguredOrigin(value, name, { allowInsecureLoopback }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError('ACTIVATION_CONFIG_INVALID', `${name} is not a valid URL`, { field: name });
  }
  const insecureLoopback = allowInsecureLoopback
    && url.protocol === 'http:'
    && isLoopbackHostname(url.hostname);
  if ((url.protocol !== 'https:' && !insecureLoopback)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash) {
    throw new DomainError('ACTIVATION_CONFIG_INVALID', `${name} is not a safe origin`, { field: name });
  }
  return url.origin;
}

function activationConfigFromEnv(env = process.env) {
  const allowInsecureLoopback = env.BIOS_IMPLANT_ALLOW_INSECURE_LOCAL_TEST === '1';
  return {
    setupOrigin: parseConfiguredOrigin(
      env.BIOS_IMPLANT_SETUP_ORIGIN ?? DEFAULT_SETUP_ORIGIN,
      'BIOS_IMPLANT_SETUP_ORIGIN',
      { allowInsecureLoopback },
    ),
    registryOrigin: parseConfiguredOrigin(
      env.BIOS_IMPLANT_REGISTRY_ORIGIN ?? DEFAULT_REGISTRY_ORIGIN,
      'BIOS_IMPLANT_REGISTRY_ORIGIN',
      { allowInsecureLoopback },
    ),
  };
}

function parseSetupUrl(rawUrl, config) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DomainError('SETUP_URL_INVALID', 'The setup URL is invalid.', {});
  }
  const match = /^\/setup\/([A-Za-z0-9_-]{43,})\/SETUP\.md$/u.exec(url.pathname);
  if (url.origin !== config.setupOrigin
    || url.username
    || url.password
    || url.search
    || url.hash
    || !match) {
    throw new DomainError('SETUP_URL_INVALID', 'The setup URL is not an approved Agent University setup URL.', {});
  }
  return { url, capability: match[1] };
}

async function boundedResponseText(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ACTIVATION_RESPONSE_BYTES) {
    throw new DomainError('ACTIVATION_RESPONSE_TOO_LARGE', 'The activation service returned an oversized response.', {});
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ACTIVATION_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DomainError('ACTIVATION_RESPONSE_TOO_LARGE', 'The activation service returned an oversized response.', {});
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseSetupDocument(document, expectedCapability, config) {
  const agentMatch = /(?:^|\n)agent_id:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,254})\s*(?:\n|$)/u.exec(document);
  const endpointMatch = /-X POST '([^'\r\n]+)'/u.exec(document);
  const capabilityMatch = /-H 'X-Enrollment-Capability:\s*([A-Za-z0-9_-]+)'/u.exec(document);
  if (!agentMatch || !endpointMatch || !capabilityMatch) {
    throw new DomainError('SETUP_DOCUMENT_INVALID', 'The setup document is missing its activation contract.', {});
  }
  if (capabilityMatch[1] !== expectedCapability) {
    throw new DomainError('SETUP_DOCUMENT_INVALID', 'The setup document capability does not match its URL.', {});
  }

  let activationUrl;
  try {
    activationUrl = new URL(endpointMatch[1]);
  } catch {
    throw new DomainError('SETUP_DOCUMENT_INVALID', 'The setup document activation endpoint is invalid.', {});
  }
  if (activationUrl.origin !== config.registryOrigin
    || activationUrl.pathname !== '/api/registry/activate'
    || activationUrl.username
    || activationUrl.password
    || activationUrl.search
    || activationUrl.hash) {
    throw new DomainError('SETUP_DOCUMENT_INVALID', 'The setup document activation endpoint is not approved.', {});
  }
  return {
    agentId: agentMatch[1],
    activationUrl: activationUrl.href,
  };
}

function activationRetryable(status, code) {
  if (status === 400 || status === 502 || status === 503) return true;
  if (status === 500 && code === 'REGISTRY_E_UNAVAILABLE') return true;
  return false;
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function localActivate(setupUrl) {
  const config = activationConfigFromEnv();
  const setup = parseSetupUrl(setupUrl, config);
  let setupResponse;
  try {
    setupResponse = await fetch(setup.url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'text/markdown' },
      signal: AbortSignal.timeout(ACTIVATION_TIMEOUT_MS),
    });
  } catch {
    throw new DomainError(
      'SETUP_UNREACHABLE',
      'The native host could not reach the setup service; the one-use link was not spent.',
      { retryable: true, link_spent: false },
    );
  }
  if (setupResponse.status !== 200) {
    throw new DomainError(
      setupResponse.status === 404 ? 'SETUP_NOT_FOUND' : 'SETUP_UNAVAILABLE',
      `The setup service returned HTTP ${setupResponse.status}; activation was not attempted.`,
      { status: setupResponse.status, retryable: setupResponse.status >= 500, link_spent: false },
    );
  }
  const setupDocument = await boundedResponseText(setupResponse);
  const contract = parseSetupDocument(setupDocument, setup.capability, config);

  let activationResponse;
  try {
    activationResponse = await fetch(contract.activationUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'x-enrollment-capability': setup.capability,
      },
      signal: AbortSignal.timeout(ACTIVATION_TIMEOUT_MS),
    });
  } catch {
    throw new DomainError(
      'ACTIVATION_UNREACHABLE',
      'The native host could not reach the activation service; the one-use link was not spent.',
      { retryable: true, link_spent: false },
    );
  }

  const responseBody = await boundedResponseText(activationResponse);
  const payload = parseJsonObject(responseBody);
  const responseCode = typeof payload?.error?.code === 'string'
    ? payload.error.code
    : (typeof payload?.code === 'string' ? payload.code : null);
  if (activationResponse.status !== 200) {
    throw new DomainError(
      responseCode ?? 'ACTIVATION_FAILED',
      `Activation returned HTTP ${activationResponse.status}.`,
      {
        status: activationResponse.status,
        retryable: activationRetryable(activationResponse.status, responseCode),
        link_spent: activationResponse.status === 404 ? null : false,
      },
    );
  }
  if (payload?.agent_id !== contract.agentId || payload?.bound !== true) {
    throw new DomainError(
      'ACTIVATION_RESPONSE_INVALID',
      'Activation succeeded but returned an invalid identity contract; do not retry the one-use link.',
      { status: 200, retryable: false, link_spent: true },
    );
  }
  return {
    ok: true,
    status: 200,
    agent_id: contract.agentId,
    bound: true,
    link_spent: true,
  };
}

function createTextResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError,
  };
}

function renderSelection(selection) {
  if (!selection.bound) {
    return `No folder binding found for ${selection.workspace_root}.`;
  }
  return `Bound ${selection.workspace_root} to ${selection.agent_id}/${selection.label}.`;
}

function renderStatus(status) {
  if (!status.staged) {
    return status.agent_id
      ? `No staged BIOS found for ${status.agent_id}/${status.label}.`
      : 'No binding found for the current workspace.';
  }
  return `Staged ${status.agent_id}/${status.label} at version ${status.bios_version}.`;
}

function renderDoctor(doctor) {
  const warningSuffix = doctor.warnings.length > 0 ? ` Warnings: ${doctor.warnings.join(', ')}.` : '';
  const errorSuffix = doctor.errors.length > 0 ? ` Errors: ${doctor.errors.join(', ')}.` : '';
  const health = doctor.healthy ? 'Healthy' : 'Unhealthy';
  if (doctor.selected_binding) {
    return `${health}: state root ${doctor.state_root.canonical_path}; bound ${doctor.selected_binding.agent_id}/${doctor.selected_binding.label}.${warningSuffix}${errorSuffix}`;
  }
  return `${health}: state root ${doctor.state_root.canonical_path}; no active folder binding.${warningSuffix}${errorSuffix}`;
}

async function executeTool(session, name, args) {
  switch (name) {
    case 'local_activate': {
      const result = await localActivate(args.setup_url);
      return createTextResult(
        `Activated ${result.agent_id}. The one-use setup link is now spent.`,
        result,
      );
    }
    case 'local_connect': {
      const result = await localConnect({
        agentId: args.agent_id,
        label: args.label ?? DEFAULT_BINDING_LABEL,
        folder: args.folder,
        roots: await session.getRoots(),
      });
      return createTextResult(
        `Bound ${result.workspace_root} to ${result.agent_id}/${result.label}.`,
        result,
      );
    }
    case 'local_selection': {
      const result = await localSelection({
        folder: args.folder,
        roots: await session.getRoots(),
      });
      return createTextResult(renderSelection(result), result);
    }
    case 'local_stage': {
      const result = await localStage({
        agentId: args.agent_id,
        label: args.label,
        body: args.body,
        version: args.version,
        etag: args.etag,
        folder: args.folder,
        roots: await session.getRoots(),
      });
      return createTextResult(
        result.changed
          ? `Staged ${result.agent_id}/${result.label} version ${result.version}.`
          : `Stage already holds ${result.agent_id}/${result.label} version ${result.version}.`,
        result,
      );
    }
    case 'local_status': {
      const result = await localStatus({
        agentId: args.agent_id ?? null,
        label: args.label ?? null,
        folder: args.folder,
        roots: await session.getRoots(),
      });
      return createTextResult(renderStatus(result), result);
    }
    case 'local_doctor': {
      const result = await localDoctor({
        folder: args.folder,
        roots: await session.getRoots(),
      });
      return createTextResult(renderDoctor(result), result, !result.healthy);
    }
    default:
      throw new DomainError('UNKNOWN_TOOL', `unknown tool ${name}`, { tool: name });
  }
}

function makeErrorResponse(id, code, message, data = undefined) {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function makeResult(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function createSession({
  output = process.stdout,
  error = process.stderr,
  listRoots = null,
  clientRequestTimeoutMs = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
} = {}) {
  let nextClientRequestId = 1;
  const pendingClientRequests = new Map();
  const requestTimeoutMs = Number.isFinite(clientRequestTimeoutMs) && clientRequestTimeoutMs > 0
    ? Math.round(clientRequestTimeoutMs)
    : DEFAULT_CLIENT_REQUEST_TIMEOUT_MS;

  return {
    output,
    error,
    async getRoots() {
      if (typeof listRoots === 'function') {
        return listRoots();
      }
      const response = await this.callClient('roots/list', {});
      return Array.isArray(response?.roots) ? response.roots : [];
    },
    callClient(method, params) {
      const id = nextClientRequestId++;
      const request = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingClientRequests.delete(id);
          reject(new DomainError(
            'CLIENT_REQUEST_TIMEOUT',
            `client did not respond to ${method} in time`,
            { method },
          ));
        }, requestTimeoutMs);
        pendingClientRequests.set(id, { resolve, reject, timer });
        try {
          this.send(request);
        } catch (sendError) {
          clearTimeout(timer);
          pendingClientRequests.delete(id);
          reject(sendError);
        }
      });
    },
    send(message) {
      output.write(`${JSON.stringify(message)}\n`);
    },
    writeDiagnostic(message) {
      error.write(`${message}\n`);
    },
    resolveClientResponse(message) {
      if (!pendingClientRequests.has(message.id)) {
        return false;
      }
      const pending = pendingClientRequests.get(message.id);
      pendingClientRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (Object.prototype.hasOwnProperty.call(message, 'error')) {
        pending.reject(new Error(message.error?.message ?? 'client request failed'));
      } else {
        pending.resolve(message.result ?? null);
      }
      return true;
    },
    rejectPending(reason) {
      for (const pending of pendingClientRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(reason);
      }
      pendingClientRequests.clear();
    },
  };
}

export async function handleRequest(session, message) {
  if (!message || message.jsonrpc !== '2.0') {
    return makeErrorResponse(message?.id ?? null, -32600, 'invalid request');
  }

  if (!Object.prototype.hasOwnProperty.call(message, 'method')) {
    const resolved = session.resolveClientResponse(message);
    return resolved ? null : makeErrorResponse(message.id ?? null, -32600, 'unexpected response');
  }

  if (message.method === 'initialized' || message.method === 'notifications/initialized') {
    return null;
  }

  if (message.method === 'ping') {
    return makeResult(message.id ?? null, {});
  }

  if (message.method === 'initialize') {
    return makeResult(message.id ?? null, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
  }

  if (message.method === 'tools/list') {
    return makeResult(message.id ?? null, {
      tools: TOOL_DEFINITIONS,
    });
  }

  if (message.method === 'tools/call') {
    if (!message.params || typeof message.params.name !== 'string') {
      return makeErrorResponse(message.id ?? null, -32602, 'tools/call requires a tool name');
    }
    try {
      const result = await executeTool(session, message.params.name, message.params.arguments ?? {});
      return makeResult(message.id ?? null, result);
    } catch (error) {
      if (error instanceof DomainError) {
        return makeResult(
          message.id ?? null,
          createTextResult(error.message, { ok: false, code: error.code, details: error.details }, true),
        );
      }
      session.writeDiagnostic(`[${SERVER_NAME}] ${safeErrorMessage(error)}`);
      return makeResult(
        message.id ?? null,
        createTextResult('internal error', { ok: false, code: 'INTERNAL_ERROR' }, true),
      );
    }
  }

  if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
    // A notification (no id) must never receive a response, even for unknown methods.
    return null;
  }
  return makeErrorResponse(message.id, -32601, `method not found: ${message.method}`);
}

export async function runStdio(options = {}) {
  const input = options.input ?? process.stdin;
  const session = createSession(options);
  const lineReader = readline.createInterface({ input, crlfDelay: Infinity });
  const inflight = new Set();

  lineReader.on('line', (line) => {
    if (line.trim() === '') {
      return;
    }
    const work = (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        session.writeDiagnostic(`[${SERVER_NAME}] invalid json: ${safeErrorMessage(error)}`);
        return;
      }
      const response = await handleRequest(session, message);
      if (response) {
        session.send(response);
      }
    })();
    inflight.add(work);
    work.finally(() => inflight.delete(work));
  });

  await new Promise((resolve) => lineReader.once('close', resolve));
  await Promise.allSettled(inflight);
  session.rejectPending(new Error('stdin closed'));
  return 0;
}

export async function main(options = {}) {
  try {
    return await runStdio(options);
  } catch (error) {
    const destination = options.error ?? process.stderr;
    destination.write(`[${SERVER_NAME}] fatal: ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

const isEntrypoint = process.argv[1]
  && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
