import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteJson, safeErrorMessage } from './util.mjs';
import {
  ACTIVE_BIOS_FILENAME,
  AGENTS_DIRNAME,
  BINDING_FILENAME,
  BINDING_REQUIRED_WARNING,
  BIOS_DIRNAME,
  DEFAULT_LABEL,
  GENERATIONS_DIRNAME,
  IDENTITY_FILENAME,
  LABELS_DIRNAME,
  MAX_STAGE_BODY_BYTES,
  PROJECTS_DIRNAME,
  SCHEMA_VERSION,
  STATUS_FILENAME,
} from './constants.mjs';

const ACTIVE_FILENAME = ACTIVE_BIOS_FILENAME ?? 'active-bios.md';
const AGENTS_DIR = AGENTS_DIRNAME ?? 'agents';
const BINDING_FILE = BINDING_FILENAME ?? 'binding.json';
const BINDING_REQUIRED = BINDING_REQUIRED_WARNING ?? 'BINDING_REQUIRED';
const BIOS_DIR = BIOS_DIRNAME ?? 'bios';
const DEFAULT_BINDING_LABEL = DEFAULT_LABEL ?? 'default';
const GENERATIONS_DIR = GENERATIONS_DIRNAME ?? 'generations';
const IDENTITY_FILE = IDENTITY_FILENAME ?? 'identity.json';
const LABELS_DIR = LABELS_DIRNAME ?? 'labels';
const MAX_BODY_BYTES = MAX_STAGE_BODY_BYTES ?? 10 * 1024 * 1024;
const PROJECTS_DIR = PROJECTS_DIRNAME ?? 'projects';
const SCHEMA = SCHEMA_VERSION ?? 1;
const STATUS_FILE = STATUS_FILENAME ?? 'status.json';
const BODY_FILENAME = 'bios.md';
export const OWNERSHIP_OWNER_ID = '@agentuniversity/bios-implant';
export const OWNERSHIP_LEDGER_RELATIVE_PATH = 'bios-implant/owned-state.jsonl';
const OWNERSHIP_LEDGER_MODE = 0o600;

// The servable alphabet. bios-server slug-validates agent_id AND label on every /load, BEFORE
// auth, admitting letters, digits and hyphen only, 64 chars max (its src/safety/slug.ts) — dots
// and underscores are excluded there on purpose. The previous wider set here bound
// TVP_TEST_2-paired-2026-08 without complaint (2026-08-10): activation succeeded, the one-use
// link was spent, and every bios_load then answered a bare `bad_shape`, permanently. Binding an
// id the server will never serve is not a binding — it is a deferred failure, so the rule here
// must be the serve-side rule. Byte-identical twins: app-v2 lib/setup/render.ts
// (AGENT_ID_SERVABLE) and the local-companion tool schemas, which derive from these constants.
export const AGENT_ID_PATTERN = '[A-Za-z0-9][A-Za-z0-9-]{0,63}';
export const LABEL_PATTERN = AGENT_ID_PATTERN; // labels face the same bios-server slug check
export const AGENT_ID_RE = new RegExp(`^${AGENT_ID_PATTERN}$`);
export const LABEL_RE = new RegExp(`^${LABEL_PATTERN}$`);

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export class DowngradeRefused extends DomainError {
  constructor(agentId, label, version, currentVersion) {
    super(
      'DOWNGRADE_REFUSED',
      `refusing to stage ${agentId}/${label} v${version} below active v${currentVersion}`,
      { agent_id: agentId, label, version, current_version: currentVersion },
    );
  }
}

export class StatusUnreadable extends DomainError {
  constructor(statusPath, reason) {
    super('STATUS_UNREADABLE', `status at ${statusPath} is unreadable: ${reason}`, {
      status_path: statusPath,
    });
  }
}

export class BindingUnreadable extends DomainError {
  constructor(bindingPath) {
    super('BINDING_UNREADABLE', 'folder binding is unreadable', {
      binding_path: bindingPath,
    });
  }
}

export class VersionConflict extends DomainError {
  constructor(agentId, label, version) {
    super(
      'VERSION_CONFLICT',
      `refusing to overwrite ${agentId}/${label} v${version} with different content`,
      { agent_id: agentId, label, version },
    );
  }
}

export class StagedBiosUnreadable extends DomainError {
  constructor(activePath, reason, details = {}) {
    super('STAGED_BIOS_UNREADABLE', `staged BIOS at ${activePath} is unreadable: ${reason}`, {
      active_path: activePath,
      reason,
      ...details,
    });
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceComponent(value, kind, pattern) {
  if (typeof value !== 'string' || !pattern.test(value) || !isOnePathComponent(value)) {
    throw new DomainError(
      kind === 'agent_id' ? 'INVALID_AGENT_ID' : 'INVALID_LABEL',
      `invalid ${kind}: ${JSON.stringify(value)}`,
      { [kind]: value },
    );
  }
  return value;
}

export function isOnePathComponent(value) {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length === 0 || value.length > 255) {
    return false;
  }
  if (value === '.' || value === '..') {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  if (value.includes('/') || value.includes('\\')) {
    return false;
  }
  if (/^[A-Za-z]:/u.test(value)) {
    return false;
  }
  if (value.startsWith('//') || value.startsWith('\\\\')) {
    return false;
  }
  return true;
}

export function validateAgentId(value) {
  return coerceComponent(value, 'agent_id', AGENT_ID_RE);
}

export function validateLabel(value) {
  return coerceComponent(value ?? DEFAULT_BINDING_LABEL, 'label', LABEL_RE);
}

export function getConfiguredStateRoot() {
  return path.resolve(
    process.env.BIOS_IMPLANT_STATE_ROOT
      ?? process.env.AGENT_UNIVERSITY_HOME
      ?? path.join(os.homedir(), '.agent-university'),
  );
}

async function inspectStateRoot(stateRoot = null) {
  const configured = path.resolve(stateRoot ?? getConfiguredStateRoot());
  try {
    const stat = await fs.stat(configured);
    if (!stat.isDirectory()) {
      throw new DomainError('STATE_ROOT_UNREADABLE', 'state root must be a directory', {
        state_root: configured,
      });
    }
    return {
      configured_path: configured,
      canonical_path: await fs.realpath(configured),
      exists: true,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        configured_path: configured,
        canonical_path: configured,
        exists: false,
      };
    }
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError('STATE_ROOT_UNREADABLE', 'state root is unreadable', {
      state_root: configured,
    });
  }
}

export async function resolveStateRootForRead(stateRoot = null) {
  const inspected = await inspectStateRoot(stateRoot);
  return inspected.canonical_path;
}

export async function ensureStateRoot(stateRoot = null) {
  const configured = path.resolve(stateRoot ?? getConfiguredStateRoot());
  await fs.mkdir(configured, { recursive: true });
  return fs.realpath(configured);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function accessMode(targetPath, mode) {
  try {
    await fs.access(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function asPathString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError('INVALID_FOLDER', `${fieldName} must be a non-empty path`, { [fieldName]: value });
  }
  if (value.startsWith('file://')) {
    return fileURLToPath(value);
  }
  return path.resolve(value);
}

async function realDirectory(rawPath, fieldName) {
  const resolved = asPathString(rawPath, fieldName);
  let realPath;
  try {
    realPath = await fs.realpath(resolved);
  } catch (error) {
    throw new DomainError('DIRECTORY_REQUIRED', `${fieldName} must reference an existing directory`, {
      [fieldName]: resolved,
      reason: safeErrorMessage(error),
    });
  }
  let stat;
  try {
    stat = await fs.stat(realPath);
  } catch (error) {
    throw new DomainError('DIRECTORY_REQUIRED', `${fieldName} must reference an existing directory`, {
      [fieldName]: resolved,
      reason: safeErrorMessage(error),
    });
  }
  if (!stat.isDirectory()) {
    throw new DomainError('DIRECTORY_REQUIRED', `${fieldName} must reference a directory`, { [fieldName]: realPath });
  }
  return realPath;
}

function isWithinRoot(candidatePath, rootPath) {
  if (candidatePath === rootPath) {
    return true;
  }
  const relative = path.relative(rootPath, candidatePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function normalizeRoots(rawRoots = []) {
  const roots = [];
  for (const entry of rawRoots ?? []) {
    const rawPath = typeof entry === 'string' ? entry : entry?.uri;
    if (!rawPath) {
      continue;
    }
    const realPath = await realDirectory(rawPath, 'root');
    roots.push({
      uri: typeof entry === 'object' && typeof entry?.uri === 'string' ? entry.uri : undefined,
      workspace_root: realPath,
    });
  }
  return roots;
}

export async function resolveWorkspaceFolder({ folder, roots = [], requireRoot = true } = {}) {
  const normalizedRoots = await normalizeRoots(roots);
  if (folder == null || folder === '') {
    if (normalizedRoots.length === 1) {
      return normalizedRoots[0].workspace_root;
    }
    if (requireRoot && normalizedRoots.length === 0) {
      throw new DomainError('ROOT_REQUIRED', 'a granted workspace root is required for this operation');
    }
    if (requireRoot && normalizedRoots.length > 1) {
      throw new DomainError('FOLDER_REQUIRED', 'folder must be provided when multiple workspace roots are granted');
    }
    return null;
  }

  const workspaceRoot = await realDirectory(folder, 'folder');
  if (normalizedRoots.length === 0) {
    if (requireRoot) {
      throw new DomainError('ROOT_REQUIRED', 'folder is not allowed without granted workspace roots');
    }
    return workspaceRoot;
  }
  const allowed = normalizedRoots.some((root) => isWithinRoot(workspaceRoot, root.workspace_root));
  if (!allowed) {
    throw new DomainError('FOLDER_OUTSIDE_ROOTS', 'folder must be equal to or inside a granted workspace root', {
      folder: workspaceRoot,
      roots: normalizedRoots.map((root) => root.workspace_root),
    });
  }
  return workspaceRoot;
}

export function hashWorkspaceRoot(workspaceRoot) {
  return crypto.createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
}

function bindingDirectory(stateRoot, workspaceRoot) {
  return path.join(stateRoot, BIOS_DIR, PROJECTS_DIR, hashWorkspaceRoot(workspaceRoot));
}

function agentRoot(stateRoot, agentId) {
  return path.join(stateRoot, AGENTS_DIR, agentId);
}

function identityPathForAgent(stateRoot, agentId) {
  return path.join(agentRoot(stateRoot, agentId), IDENTITY_FILE);
}

function canonicalStageHome(stateRoot, agentId, label) {
  const root = agentRoot(stateRoot, agentId);
  return label === DEFAULT_BINDING_LABEL ? root : path.join(root, LABELS_DIR, label);
}

function compatibilityStageHome(stateRoot, agentId, label) {
  return path.join(stateRoot, BIOS_DIR, AGENTS_DIR, agentId, label);
}

function stageHomeCandidates(stateRoot, agentId, label) {
  return [
    { layout: 'canonical', home: canonicalStageHome(stateRoot, agentId, label) },
    { layout: 'compat_bios_agents', home: compatibilityStageHome(stateRoot, agentId, label) },
  ];
}

function sanitizeEtag(etag) {
  const normalized = String(etag ?? '').replace(/^"+|"+$/gu, '').replace(/[^A-Za-z0-9._-]+/gu, '');
  return normalized.slice(0, 12) || 'noetag';
}

function digestText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function digestBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeOwnedRelativePath(stateRoot, targetPath) {
  const relativePath = path.relative(stateRoot, targetPath);
  if (
    relativePath === ''
    || relativePath === '.'
    || relativePath.startsWith('..')
    || path.isAbsolute(relativePath)
  ) {
    throw new DomainError('OWNERSHIP_PATH_INVALID', `refusing to record ownership outside ${stateRoot}`, {
      state_root: stateRoot,
      target_path: targetPath,
    });
  }
  return relativePath.split(path.sep).join('/');
}

function ownershipLedgerPath(stateRoot) {
  return path.join(stateRoot, ...OWNERSHIP_LEDGER_RELATIVE_PATH.split('/'));
}

async function appendOwnershipRecord(stateRoot, targetPath, kind) {
  const normalizedRelativePath = normalizeOwnedRelativePath(stateRoot, targetPath);
  const ledgerPath = ownershipLedgerPath(stateRoot);
  const bytes = await fs.readFile(targetPath);
  const record = {
    schema_version: SCHEMA,
    owner: OWNERSHIP_OWNER_ID,
    relative_path: normalizedRelativePath,
    kind,
    digest_sha256: digestBytes(bytes),
  };

  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: OWNERSHIP_LEDGER_MODE });
  if (process.platform !== 'win32') {
    await fs.chmod(ledgerPath, OWNERSHIP_LEDGER_MODE).catch(() => {});
  }
}

export async function readOwnershipLedger({ stateRoot = null } = {}) {
  const root = stateRoot ?? getConfiguredStateRoot();
  const ledgerPath = ownershipLedgerPath(root);
  const text = await fs.readFile(ledgerPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (text == null) {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

async function atomicWriteText(targetPath, content, options = {}) {
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, 'wx', options.mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    if (typeof options.mode === 'number') {
      await fs.chmod(temporaryPath, options.mode).catch(() => {});
    }
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJsonDocumentIfExists(targetPath) {
  let content;
  try {
    content = await fs.readFile(targetPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, data: null };
    }
    throw error;
  }
  return { exists: true, data: JSON.parse(content) };
}

function parseStatusRecord(data, requestedAgentId, requestedLabel, statusPath) {
  if (!isPlainObject(data)) {
    throw new StatusUnreadable(statusPath, 'expected an object');
  }
  const agentId = validateAgentId(data.agent_id);
  if (agentId !== requestedAgentId) {
    throw new StatusUnreadable(statusPath, `unexpected agent_id ${JSON.stringify(data.agent_id)}`);
  }
  const label = typeof data.label === 'string' ? validateLabel(data.label) : requestedLabel;
  if (label !== requestedLabel) {
    throw new StatusUnreadable(statusPath, `unexpected label ${JSON.stringify(data.label)}`);
  }
  const biosVersion = Number(data.bios_version);
  if (!Number.isSafeInteger(biosVersion) || biosVersion < 0) {
    throw new StatusUnreadable(statusPath, `invalid bios_version ${JSON.stringify(data.bios_version)}`);
  }
  if (typeof data.etag !== 'string') {
    throw new StatusUnreadable(statusPath, 'missing etag');
  }
  if (typeof data.active !== 'string') {
    throw new StatusUnreadable(statusPath, 'missing active path');
  }
  return {
    schema_version: typeof data.schema_version === 'number' ? data.schema_version : null,
    agent_id: agentId,
    label,
    bios_version: biosVersion,
    etag: data.etag,
    digest: typeof data.digest === 'string' ? data.digest : null,
    staged_at: typeof data.staged_at === 'string' ? data.staged_at : null,
    active: data.active,
  };
}

async function readStatusSnapshot(stateRoot, agentId, label) {
  for (const candidate of stageHomeCandidates(stateRoot, agentId, label)) {
    const statusPath = path.join(candidate.home, STATUS_FILE);
    let data;
    try {
      const document = await readJsonDocumentIfExists(statusPath);
      if (!document.exists) {
        continue;
      }
      data = document.data;
      const status = parseStatusRecord(data, agentId, label, statusPath);
      await validateGenerationPath(candidate.home, status, statusPath);
      return { ...candidate, status_path: statusPath, status };
    } catch (error) {
      if (error instanceof StatusUnreadable) {
        throw error;
      }
      if (error instanceof DomainError) {
        throw new StatusUnreadable(statusPath, error.message);
      }
      throw new StatusUnreadable(statusPath, safeErrorMessage(error));
    }
  }
  return null;
}

async function validateGenerationPath(home, status, statusPath = null) {
  const activePath = status?.active;
  const invalid = (reason) => {
    if (statusPath) {
      throw new StatusUnreadable(statusPath, reason);
    }
    throw new StagedBiosUnreadable(
      typeof activePath === 'string' && activePath ? activePath : '<unknown>',
      reason,
    );
  };

  if (typeof activePath !== 'string' || activePath.length === 0 || !path.isAbsolute(activePath)) {
    return invalid('active generation path is not absolute');
  }
  const normalizedActivePath = path.normalize(activePath);
  if (normalizedActivePath !== activePath) {
    return invalid('active generation path is not normalized');
  }
  const components = normalizedActivePath.split(path.sep);
  const generationName = components.at(-2);
  if (
    components.length < 4
    || components.at(-1) !== BODY_FILENAME
    || components.at(-3) !== GENERATIONS_DIR
    || !generationName.startsWith(`${status.bios_version}-`)
  ) {
    return invalid('active generation path is outside the expected stage layout');
  }

  const expectedCanonicalPath = path.join(home, GENERATIONS_DIR, generationName, BODY_FILENAME);
  try {
    const canonicalParent = await fs.realpath(path.dirname(normalizedActivePath));
    const canonicalCandidate = path.join(canonicalParent, BODY_FILENAME);
    if (canonicalCandidate !== expectedCanonicalPath) {
      return invalid('active generation path is outside the expected stage layout');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return invalid('active generation path cannot be resolved safely');
    }
  }
  return {
    active_path: normalizedActivePath,
    canonical_path: expectedCanonicalPath,
  };
}

async function readStagedGeneration(home, status) {
  const validatedPath = await validateGenerationPath(home, status);
  const activePath = validatedPath.active_path;
  let handle;
  try {
    const realActivePath = await fs.realpath(activePath);
    if (realActivePath !== validatedPath.canonical_path) {
      throw new StagedBiosUnreadable(activePath, 'active generation path resolves outside the stage layout');
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    handle = await fs.open(activePath, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new StagedBiosUnreadable(activePath, 'active generation is not a regular file');
    }
    if (stat.size > MAX_BODY_BYTES) {
      throw new StagedBiosUnreadable(activePath, 'body exceeds size limit', {
        size: stat.size,
        limit: MAX_BODY_BYTES,
      });
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new StagedBiosUnreadable(activePath, 'body exceeds size limit', {
        size: bytes.byteLength,
        limit: MAX_BODY_BYTES,
      });
    }
    return {
      body: bytes.toString('utf8'),
      digest: digestBytes(bytes),
    };
  } catch (error) {
    if (error instanceof StagedBiosUnreadable) {
      throw error;
    }
    throw new StagedBiosUnreadable(activePath, 'missing or unreadable body', {
      cause: safeErrorMessage(error),
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readValidatedStagedBody(home, status) {
  if (typeof status?.digest !== 'string' || status.digest.length === 0) {
    throw new StagedBiosUnreadable(status?.active ?? '<unknown>', 'missing digest');
  }
  const staged = await readStagedGeneration(home, status);
  if (staged.digest !== status.digest) {
    throw new StagedBiosUnreadable(status.active, 'digest mismatch', {
      expected_digest: status.digest,
      actual_digest: staged.digest,
    });
  }
  return staged.body;
}

async function readBindingPayload(bindingPath) {
  try {
    const document = await readJsonDocumentIfExists(bindingPath);
    if (!document.exists) {
      return null;
    }
    const data = document.data;
    if (!isPlainObject(data)) {
      throw new BindingUnreadable(bindingPath);
    }
    return data;
  } catch (error) {
    if (error instanceof BindingUnreadable) {
      throw error;
    }
    throw new BindingUnreadable(bindingPath);
  }
}

export async function readBindingRecord({ workspaceRoot, stateRoot = null }) {
  const root = stateRoot ?? getConfiguredStateRoot();
  const realWorkspaceRoot = await realDirectory(workspaceRoot, 'folder');
  const bindingPath = path.join(bindingDirectory(root, realWorkspaceRoot), BINDING_FILE);
  const data = await readBindingPayload(bindingPath);
  if (!data) {
    return null;
  }
  try {
    if (data.schema_version != null && !Number.isSafeInteger(data.schema_version)) {
      throw new Error('invalid schema_version');
    }
    if (data.updated_at != null && typeof data.updated_at !== 'string') {
      throw new Error('invalid updated_at');
    }
    const recordedWorkspaceRoot = data.workspace_root ?? data.path ?? null;
    if (
      recordedWorkspaceRoot != null
      && (typeof recordedWorkspaceRoot !== 'string' || recordedWorkspaceRoot.trim() === '')
    ) {
      throw new Error('invalid workspace_root');
    }
    if (
      typeof recordedWorkspaceRoot === 'string'
      && path.resolve(recordedWorkspaceRoot) !== realWorkspaceRoot
    ) {
      throw new Error('unexpected workspace_root');
    }
    return {
      schema_version: typeof data.schema_version === 'number' ? data.schema_version : null,
      agent_id: validateAgentId(data.agent_id),
      label: validateLabel(data.label ?? DEFAULT_BINDING_LABEL),
      workspace_root: realWorkspaceRoot,
      updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
      binding_path: bindingPath,
      binding_hash: hashWorkspaceRoot(realWorkspaceRoot),
    };
  } catch (error) {
    if (error instanceof BindingUnreadable) {
      throw error;
    }
    throw new BindingUnreadable(bindingPath);
  }
}

export async function localConnect({ agentId, label = DEFAULT_BINDING_LABEL, folder, roots = [] }) {
  const validatedAgentId = validateAgentId(agentId);
  const validatedLabel = validateLabel(label);
  const workspaceRoot = await resolveWorkspaceFolder({ folder, roots, requireRoot: true });
  const stateRoot = await ensureStateRoot();
  const updatedAt = new Date().toISOString();

  const identityPath = identityPathForAgent(stateRoot, validatedAgentId);
  await atomicWriteJson(
    identityPath,
    {
      schema_version: SCHEMA,
      agent_id: validatedAgentId,
      updated_at: updatedAt,
    },
    { mode: 0o600 },
  );
  await appendOwnershipRecord(stateRoot, identityPath, 'identity');

  const bindingPath = path.join(bindingDirectory(stateRoot, workspaceRoot), BINDING_FILE);
  await atomicWriteJson(bindingPath, {
    schema_version: SCHEMA,
    agent_id: validatedAgentId,
    label: validatedLabel,
    workspace_root: workspaceRoot,
    updated_at: updatedAt,
  });
  await appendOwnershipRecord(stateRoot, bindingPath, 'binding');

  return {
    agent_id: validatedAgentId,
    label: validatedLabel,
    workspace_root: workspaceRoot,
    state_root: stateRoot,
    identity_path: identityPath,
    binding_path: bindingPath,
    binding_hash: hashWorkspaceRoot(workspaceRoot),
    updated_at: updatedAt,
  };
}

export async function localSelection({ folder, roots = [] } = {}) {
  const workspaceRoot = await resolveWorkspaceFolder({ folder, roots, requireRoot: true });
  const stateRoot = await resolveStateRootForRead();
  const binding = await readBindingRecord({ workspaceRoot, stateRoot });
  if (!binding) {
    return {
      bound: false,
      workspace_root: workspaceRoot,
      state_root: stateRoot,
      warnings: [BINDING_REQUIRED],
    };
  }
  return {
    bound: true,
    workspace_root: workspaceRoot,
    state_root: stateRoot,
    warnings: [],
    ...binding,
  };
}

export async function stageBios({ agentId, label = DEFAULT_BINDING_LABEL, body, version, etag, stateRoot = null }) {
  const validatedAgentId = validateAgentId(agentId);
  const validatedLabel = validateLabel(label);
  if (typeof body !== 'string') {
    throw new DomainError('INVALID_BODY', 'body must be a string');
  }
  const size = Buffer.byteLength(body, 'utf8');
  if (size > MAX_BODY_BYTES) {
    throw new DomainError('BODY_TOO_LARGE', `body exceeds ${MAX_BODY_BYTES} bytes`, { size, limit: MAX_BODY_BYTES });
  }
  const biosVersion = Number(version);
  if (!Number.isSafeInteger(biosVersion) || biosVersion < 0) {
    throw new DomainError('INVALID_VERSION', 'version must be a non-negative integer', { version });
  }
  if (typeof etag !== 'string' || etag.length === 0) {
    throw new DomainError('INVALID_ETAG', 'etag must be a non-empty string', { etag });
  }

  const root = await ensureStateRoot(stateRoot);
  const current = await readStatusSnapshot(root, validatedAgentId, validatedLabel);
  const bodyDigest = digestText(body);
  if (current) {
    const currentVersion = current.status.bios_version;
    if (biosVersion < currentVersion) {
      throw new DowngradeRefused(validatedAgentId, validatedLabel, biosVersion, currentVersion);
    }
    if (biosVersion === currentVersion) {
      const currentGeneration = await readStagedGeneration(current.home, current.status);
      if (currentGeneration.body === body) {
        const activePath = path.join(current.home, ACTIVE_FILENAME);
        let changed = false;
        let stagedAt = current.status.staged_at;
        if (current.status.digest !== currentGeneration.digest) {
          stagedAt ??= new Date().toISOString();
          await atomicWriteJson(current.status_path, {
            schema_version: current.status.schema_version ?? SCHEMA,
            agent_id: validatedAgentId,
            label: validatedLabel,
            bios_version: currentVersion,
            etag: current.status.etag,
            digest: currentGeneration.digest,
            staged_at: stagedAt,
            active: current.status.active,
          });
          await appendOwnershipRecord(root, current.status_path, 'status');
          changed = true;
        }
        return {
          agent_id: validatedAgentId,
          label: validatedLabel,
          version: biosVersion,
          etag: current.status.etag,
          digest: currentGeneration.digest,
          staged_at: stagedAt,
          generation_path: current.status.active,
          active_path: activePath,
          status_path: current.status_path,
          state_root: root,
          changed,
        };
      }
      throw new VersionConflict(validatedAgentId, validatedLabel, biosVersion);
    }
  }

  const home = canonicalStageHome(root, validatedAgentId, validatedLabel);
  const generationPath = path.join(home, GENERATIONS_DIR, `${biosVersion}-${sanitizeEtag(etag)}`, BODY_FILENAME);
  const statusPath = path.join(home, STATUS_FILE);
  const activePath = path.join(home, ACTIVE_FILENAME);
  const stagedAt = new Date().toISOString();

  await atomicWriteText(generationPath, body);
  await appendOwnershipRecord(root, generationPath, 'generation');
  await atomicWriteJson(statusPath, {
    schema_version: SCHEMA,
    agent_id: validatedAgentId,
    label: validatedLabel,
    bios_version: biosVersion,
    etag,
    digest: bodyDigest,
    staged_at: stagedAt,
    active: generationPath,
  });
  await appendOwnershipRecord(root, statusPath, 'status');
  await atomicWriteText(activePath, body);
  await appendOwnershipRecord(root, activePath, 'active');

  return {
    agent_id: validatedAgentId,
    label: validatedLabel,
    version: biosVersion,
    etag,
    digest: bodyDigest,
    staged_at: stagedAt,
    generation_path: generationPath,
    active_path: activePath,
    status_path: statusPath,
    state_root: root,
    changed: true,
  };
}

export async function localStage({ agentId, label = DEFAULT_BINDING_LABEL, body, version, etag, folder, roots = [] }) {
  const selection = await localSelection({ folder, roots });
  if (!selection.bound) {
    throw new DomainError('BINDING_REQUIRED', 'connect this workspace before staging BIOS', {
      warnings: selection.warnings,
    });
  }
  const validatedAgentId = validateAgentId(agentId);
  const validatedLabel = validateLabel(label);
  if (selection.agent_id !== validatedAgentId || selection.label !== validatedLabel) {
    throw new DomainError('BINDING_MISMATCH', 'stage target does not match the current folder binding', {
      expected_agent_id: selection.agent_id,
      expected_label: selection.label,
      agent_id: validatedAgentId,
      label: validatedLabel,
    });
  }
  const staged = await stageBios({
    agentId: validatedAgentId,
    label: validatedLabel,
    body,
    version,
    etag,
    stateRoot: selection.state_root,
  });
  return {
    workspace_root: selection.workspace_root,
    ...staged,
  };
}

export async function localStatus({ agentId = null, label = null, folder, roots = [], includeBody = true } = {}) {
  let selection = null;
  if (!agentId) {
    selection = await localSelection({ folder, roots });
    if (!selection.bound) {
      return {
        agent_id: null,
        label: label ?? DEFAULT_BINDING_LABEL,
        staged: false,
        workspace_root: selection.workspace_root,
        state_root: selection.state_root,
        warnings: selection.warnings,
      };
    }
    agentId = selection.agent_id;
    label = label ?? selection.label;
  } else {
    label = label ?? DEFAULT_BINDING_LABEL;
  }

  const validatedAgentId = validateAgentId(agentId);
  const validatedLabel = validateLabel(label);
  const stateRoot = selection?.state_root ?? (await resolveStateRootForRead());
  const current = await readStatusSnapshot(stateRoot, validatedAgentId, validatedLabel);
  if (!current) {
    return {
      agent_id: validatedAgentId,
      label: validatedLabel,
      staged: false,
      state_root: stateRoot,
      workspace_root: selection?.workspace_root ?? null,
      warnings: [],
    };
  }

  const activePath = path.join(current.home, ACTIVE_FILENAME);
  const activeExists = await pathExists(activePath);
  const stagedBody = await readValidatedStagedBody(current.home, current.status);
  const generationExists = await pathExists(current.status.active);
  const result = {
    agent_id: validatedAgentId,
    label: validatedLabel,
    staged: true,
    state_root: stateRoot,
    workspace_root: selection?.workspace_root ?? null,
    layout: current.layout,
    bios_version: current.status.bios_version,
    etag: current.status.etag,
    digest: current.status.digest,
    staged_at: current.status.staged_at,
    status_path: current.status_path,
    active_path: activePath,
    generation_path: current.status.active,
    active_exists: activeExists,
    generation_exists: generationExists,
    warnings: [],
  };
  if (includeBody) {
    result.bios_body = stagedBody;
  }
  return result;
}

export async function localDoctor({ folder = null, roots = [] } = {}) {
  const configuredStateRoot = getConfiguredStateRoot();
  const errors = [];
  let inspectedStateRoot;
  try {
    inspectedStateRoot = await inspectStateRoot(configuredStateRoot);
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw error;
    }
    errors.push(error.code);
    inspectedStateRoot = {
      configured_path: configuredStateRoot,
      canonical_path: configuredStateRoot,
      exists: false,
    };
  }
  const exists = inspectedStateRoot.exists;
  const canonicalStateRoot = inspectedStateRoot.canonical_path;
  const writable = exists
    ? await accessMode(canonicalStateRoot, fsConstants.W_OK)
    : await accessMode(path.dirname(canonicalStateRoot), fsConstants.W_OK);
  const safe = path.isAbsolute(canonicalStateRoot);
  if (!safe) {
    errors.push('STATE_ROOT_UNSAFE');
  }
  if (!writable) {
    errors.push('STATE_ROOT_UNWRITABLE');
  }

  let selection = null;
  const warnings = [];
  try {
    selection = await localSelection({ folder, roots });
    warnings.push(...selection.warnings);
  } catch (error) {
    if (error instanceof DomainError) {
      errors.push(error.code);
    } else {
      throw error;
    }
  }

  const selectedBinding = selection?.bound
    ? {
        agent_id: selection.agent_id,
        label: selection.label,
        workspace_root: selection.workspace_root,
        binding_path: selection.binding_path,
      }
    : null;

  let staged = null;
  if (selection?.bound) {
    try {
      staged = await localStatus({ agentId: selection.agent_id, label: selection.label, includeBody: false });
    } catch (error) {
      if (!(error instanceof DomainError)) {
        throw error;
      }
      errors.push(error.code);
    }
  }

  const uniqueErrors = [...new Set(errors)];

  return {
    healthy: uniqueErrors.length === 0,
    state_root: {
      configured_path: configuredStateRoot,
      canonical_path: canonicalStateRoot,
      exists,
      writable,
      safe,
    },
    selected_binding: selectedBinding,
    staged_bios: staged && staged.staged
      ? {
          agent_id: staged.agent_id,
          label: staged.label,
          bios_version: staged.bios_version,
          digest: staged.digest,
          active_path: staged.active_path,
          generation_path: staged.generation_path,
        }
      : null,
    errors: uniqueErrors,
    warnings: [...new Set(warnings)],
  };
}

export { BINDING_REQUIRED };
