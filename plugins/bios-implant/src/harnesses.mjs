import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CATALOG_NAME,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PLUGIN_ID,
  REMOTE_MCP
} from "./constants.mjs";
import { runCommand as sharedRunCommand, safeErrorMessage } from "./util.mjs";
import {
  COWORK_PLUGIN_NOT_OBSERVED,
  COWORK_PLUGIN_OBSERVED,
  inspectCoworkInstallation
} from "./cowork-desktop.mjs";

export const HARNESS_CLAUDE = "claude";
export const HARNESS_CODEX = "codex";
export const HARNESS_COWORK = "cowork";
export const HARNESS_AUTO = "auto";
export const HARNESS_ALL = "all";

export const EXIT_INSTALL_FAILURE = 1;
export const EXIT_DOCTOR_PARTIAL = 2;
export const EXIT_NO_SUPPORTED_HARNESS = 3;
export const EXIT_USAGE = 64;
export const EXIT_INTERNAL = 70;

export const RESULT_PASS = "PASS";
export const RESULT_WARN = "WARN";
export const RESULT_FAIL = "FAIL";
export const RESULT_SKIP = "SKIP";

export const WARNING_AUTH_REQUIRED = "AUTH_REQUIRED";
export const WARNING_BINDING_REQUIRED = "BINDING_REQUIRED";
export const WARNING_REMOTE_UNREACHABLE = "REMOTE_UNREACHABLE";
export const WARNING_NEWER_VERSION_PRESENT = "NEWER_VERSION_PRESENT";
export const WARNING_RUNTIME_PROBE_REQUIRED = "RUNTIME_PROBE_REQUIRED";
export const WARNING_SCOPE_CONFLICT = "SCOPE_CONFLICT";
export const WARNING_MCP_OWNERSHIP_CONFLICT = "MCP_OWNERSHIP_CONFLICT";
export const WARNING_CATALOG_REGISTRATION_RETAINED = "CATALOG_REGISTRATION_RETAINED";
export const FAILURE_HARNESS_UPGRADE_REQUIRED = "HARNESS_UPGRADE_REQUIRED";
export const FAILURE_HARNESS_NOT_DETECTED = "HARNESS_NOT_DETECTED";
export const FAILURE_MARKETPLACE_CONFLICT = "MARKETPLACE_CONFLICT";
export const FAILURE_REMOTE_CONFIG_INVALID = "REMOTE_CONFIG_INVALID";
export const FAILURE_COMMAND_FAILED = "COMMAND_FAILED";
export const FAILURE_COWORK_PROFILE_NOT_FOUND = "COWORK_PROFILE_NOT_FOUND";

const VALID_HARNESSES = new Set([HARNESS_AUTO, HARNESS_ALL, HARNESS_CLAUDE, HARNESS_CODEX, HARNESS_COWORK]);
const CLAUDE_MIN_VERSION = "1.0.0";
const COWORK_MIN_VERSION = "2.1.220";
const CODEX_MIN_VERSION = "0.146.0";
const DEFAULT_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 120;

function pathEntriesFromEnv(env) {
  return (env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function pathextFromEnv(env, platform) {
  if (platform !== "win32") {
    return [""];
  }

  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);
}

function buildExecutableCandidates(command, env, platform) {
  if (command.includes(path.sep)) {
    return [command];
  }

  const candidates = [];
  for (const entry of pathEntriesFromEnv(env)) {
    for (const extension of pathextFromEnv(env, platform)) {
      candidates.push(path.join(entry, `${command}${extension}`));
    }
  }

  return candidates;
}

async function fileExists(filePath, fileSystem = fsp) {
  try {
    await fileSystem.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function defaultResolveExecutable(command, {
  env = process.env,
  platform = process.platform,
  fsSync = fs
} = {}) {
  for (const candidate of buildExecutableCandidates(command, env, platform)) {
    try {
      const stat = fsSync.statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Ignore non-candidates.
    }
  }

  return null;
}

function knownUserExecutableCandidates(command, homeDirectory, env, platform) {
  const candidates = [path.join(homeDirectory, ".local", "bin", command)];

  if (command === HARNESS_CLAUDE) {
    candidates.push(path.join(homeDirectory, ".claude", "local", "claude"));
  } else if (command === HARNESS_CODEX) {
    candidates.push(path.join(homeDirectory, ".codex", "bin", "codex"));
  }

  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local");
    candidates.push(
      path.join(homeDirectory, ".local", "bin", `${command}.exe`),
      path.join(appData, "npm", `${command}.cmd`),
      path.join(appData, "npm", `${command}.exe`),
      path.join(localAppData, "Programs", command, `${command}.exe`)
    );
    if (command === HARNESS_CLAUDE) {
      candidates.push(path.join(homeDirectory, ".claude", "local", "claude.exe"));
    } else if (command === HARNESS_CODEX) {
      candidates.push(path.join(homeDirectory, ".codex", "bin", "codex.exe"));
    }
  }

  return [...new Set(candidates)];
}

async function verifiedExecutable(command, {
  homeDirectory,
  env,
  platform,
  fileSystem,
  resolveExecutable,
  deps,
  commandOptions
}) {
  let resolved = null;
  try {
    resolved = resolveExecutable(command);
  } catch {
    // Continue through the verified user-path fallbacks.
  }

  const candidates = [
    resolved,
    ...knownUserExecutableCandidates(command, homeDirectory, env, platform)
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    let stat;
    try {
      stat = await fileSystem.stat(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }

    try {
      const versionResult = await executeCommand(candidate, ["--version"], deps, {
        ...commandOptions,
        allowNonZero: true
      });
      if (versionResult.exitCode !== 0) {
        continue;
      }
      return {
        executable: candidate,
        version: parseVersionText(versionResult.stdout) ?? parseVersionText(versionResult.stderr)
      };
    } catch {
      // A file that cannot execute as a CLI is not a harness candidate.
    }
  }

  return null;
}

function parseVersionText(output) {
  const match = String(output ?? "").match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function compareSemver(left, right) {
  const normalize = (value) => {
    const [core, preRelease = ""] = String(value ?? "0.0.0").split("-");
    const parts = core.split(".").map((part) => Number.parseInt(part, 10) || 0);
    return {
      parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
      preRelease
    };
  };

  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);

  for (let index = 0; index < 3; index += 1) {
    if (leftNormalized.parts[index] > rightNormalized.parts[index]) {
      return 1;
    }

    if (leftNormalized.parts[index] < rightNormalized.parts[index]) {
      return -1;
    }
  }

  if (!leftNormalized.preRelease && rightNormalized.preRelease) {
    return 1;
  }

  if (leftNormalized.preRelease && !rightNormalized.preRelease) {
    return -1;
  }

  return leftNormalized.preRelease.localeCompare(rightNormalized.preRelease);
}

function summarizeCommand(result) {
  return {
    command: result.command,
    args: [...(result.args ?? [])],
    exit_code: result.exitCode,
    signal: result.signal ?? null
  };
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = EXIT_USAGE;
  }
}

export function resolveHarnesses(rawValues = []) {
  if (!rawValues.length) {
    return [HARNESS_AUTO];
  }

  const expanded = [];
  for (const rawValue of rawValues) {
    const values = String(rawValue)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    for (const value of values) {
      if (!VALID_HARNESSES.has(value)) {
        throw new UsageError(`Unsupported harness: ${value}`);
      }
      expanded.push(value);
    }
  }

  if (expanded.includes(HARNESS_AUTO) && expanded.length > 1) {
    throw new UsageError(`--harness ${HARNESS_AUTO} cannot be combined with other harnesses`);
  }

  if (expanded.includes(HARNESS_ALL)) {
    return [HARNESS_COWORK, HARNESS_CLAUDE, HARNESS_CODEX];
  }

  return [...new Set(expanded)];
}

async function executeCommand(command, args, deps, options = {}) {
  const runCommand = deps.runCommand ?? sharedRunCommand;
  try {
    return await runCommand(command, args, {
      allowNonZero: options.allowNonZero ?? false,
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      timeoutMs: options.timeoutMs
    });
  } catch (error) {
    if (options.allowNonZero && error?.result) {
      return error.result;
    }
    throw error;
  }
}

export function parseJsonOutput(result) {
  const text = `${result?.stdout ?? ""}`.trim() || `${result?.stderr ?? ""}`.trim();
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

function normalizeMarketplaceEntries(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && Array.isArray(value.marketplaces)) {
    return value.marketplaces;
  }

  if (value && Array.isArray(value.items)) {
    return value.items;
  }

  if (value && Array.isArray(value.entries)) {
    return value.entries;
  }

  return [];
}

function normalizePluginEntries(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && Array.isArray(value.installed)) {
    return value.installed;
  }

  if (value && Array.isArray(value.plugins)) {
    return value.plugins;
  }

  if (value && Array.isArray(value.items)) {
    return value.items;
  }

  return [];
}

function normalizeScopes(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }

  return String(value)
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function timeoutMsFor(options = {}) {
  const rawSeconds = Number(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  const boundedSeconds = Number.isFinite(rawSeconds)
    ? Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, rawSeconds))
    : DEFAULT_TIMEOUT_SECONDS;
  return Math.round(boundedSeconds * 1000);
}

export async function detectHarnesses(options = {}, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? env.HOME ?? os.homedir();
  const resolveExecutable = deps.resolveExecutable ?? ((command) => defaultResolveExecutable(command, { env, platform }));
  const fileSystem = deps.fs ?? fsp;
  const commandOptions = { timeoutMs: timeoutMsFor(options) };

  const detections = [];

  const claudeCli = await verifiedExecutable(HARNESS_CLAUDE, {
    homeDirectory,
    env,
    platform,
    fileSystem,
    resolveExecutable,
    deps,
    commandOptions
  });
  const claudeAppPaths =
    platform === "darwin"
      ? [
          "/Applications/Claude.app",
          path.join(homeDirectory, "Applications", "Claude.app")
        ]
      : [];
  let claudeAppPresent = false;
  for (const candidate of claudeAppPaths) {
    if (await fileExists(candidate, fileSystem)) {
      claudeAppPresent = true;
      break;
    }
  }

  if (claudeCli || claudeAppPresent) {
    const supported = Boolean(
      claudeCli?.version && compareSemver(claudeCli.version, CLAUDE_MIN_VERSION) >= 0
    );

    detections.push({
      harness: HARNESS_CLAUDE,
      detected: true,
      supported,
      executable: claudeCli?.executable ?? null,
      version: claudeCli?.version ?? null,
      app_present: claudeAppPresent,
      required_version: CLAUDE_MIN_VERSION,
      upgrade_required: !supported
    });
  }

  const codexCli = await verifiedExecutable(HARNESS_CODEX, {
    homeDirectory,
    env,
    platform,
    fileSystem,
    resolveExecutable,
    deps,
    commandOptions
  });
  if (codexCli) {
    const supported = Boolean(
      codexCli.version && compareSemver(codexCli.version, CODEX_MIN_VERSION) >= 0
    );
    detections.push({
      harness: HARNESS_CODEX,
      detected: true,
      supported,
      executable: codexCli.executable,
      version: codexCli.version,
      required_version: CODEX_MIN_VERSION,
      upgrade_required: !supported
    });
  }

  const byHarness = Object.fromEntries(detections.map((detection) => [detection.harness, detection]));
  if (byHarness[HARNESS_CLAUDE]) {
    const coworkCliSupported = Boolean(
      byHarness[HARNESS_CLAUDE].executable &&
      byHarness[HARNESS_CLAUDE].version &&
      compareSemver(byHarness[HARNESS_CLAUDE].version, COWORK_MIN_VERSION) >= 0
    );
    byHarness[HARNESS_COWORK] = {
      ...byHarness[HARNESS_CLAUDE],
      harness: HARNESS_COWORK,
      supported: Boolean(byHarness[HARNESS_CLAUDE].app_present && coworkCliSupported),
      required_version: COWORK_MIN_VERSION,
      upgrade_required: !coworkCliSupported,
      cowork_ready: Boolean(byHarness[HARNESS_CLAUDE].app_present && coworkCliSupported)
    };
  }
  return { detections, byHarness };
}

function getRequestedHarnesses(requestedHarnesses, detectionResult) {
  if (requestedHarnesses.length === 1 && requestedHarnesses[0] === HARNESS_AUTO) {
    if (detectionResult.byHarness?.[HARNESS_COWORK]?.app_present) {
      return [HARNESS_COWORK];
    }
    return detectionResult.detections
      .filter((detection) => detection.detected)
      .map((detection) => detection.harness);
  }

  return requestedHarnesses;
}

function findPluginEntry(entries, pluginId) {
  return normalizePluginEntries(entries).find((entry) => {
    const id = pluginEntryId(entry);
    if (id === pluginId) {
      return true;
    }

    if (entry.name === "bios-implant" && entry.namespace === "agent-university") {
      return pluginId === PLUGIN_ID;
    }

    return false;
  });
}

function findPluginEntries(entries, pluginId) {
  return normalizePluginEntries(entries).filter((entry) => pluginEntryId(entry) === pluginId);
}

function pluginEntryId(entry) {
  return entry?.pluginId ?? entry?.id ?? entry?.plugin ?? entry?.plugin_id ?? entry?.name ?? null;
}

function pluginScope(entry) {
  return entry?.scope ?? entry?.install_scope ?? entry?.location ?? "unknown";
}

function extractCallbackPort(mcpEntry) {
  const rawValue =
    mcpEntry?.callback_port ??
    mcpEntry?.callbackPort ??
    mcpEntry?.oauth?.callbackPort ??
    mcpEntry?.auth?.callbackPort;
  return Number.isFinite(Number(rawValue)) ? Number(rawValue) : null;
}

function remoteMcpFingerprint(mcpEntry) {
  return {
    name: mcpEntry?.name ?? REMOTE_MCP.name,
    url: mcpEntry?.url ?? mcpEntry?.transport?.url ?? null,
    oauth_client_id:
      mcpEntry?.oauth_client_id ??
      mcpEntry?.oauthClientId ??
      mcpEntry?.oauth?.clientId ??
      mcpEntry?.auth?.clientId ??
      null
  };
}

function canonicalRemoteMcpFingerprint() {
  return {
    name: REMOTE_MCP.name,
    url: REMOTE_MCP.url,
    oauth_client_id: REMOTE_MCP.oauth.clientId
  };
}

function verifyRemoteFingerprint(mcpEntry) {
  const observed = remoteMcpFingerprint(mcpEntry);
  const expected = canonicalRemoteMcpFingerprint();
  return {
    ok:
      observed.name === expected.name &&
      observed.url === expected.url &&
      (observed.oauth_client_id === null || observed.oauth_client_id === expected.oauth_client_id),
    observed,
    expected
  };
}

function canonicalMcpOwnershipEvidence() {
  return {
    schema_version: 1,
    owner_package: PACKAGE_NAME,
    harness: HARNESS_CODEX,
    resource_type: "mcp_server",
    ...canonicalRemoteMcpFingerprint()
  };
}

function hasCanonicalMcpOwnership(evidence) {
  const expected = canonicalMcpOwnershipEvidence();
  return Boolean(
    evidence &&
    evidence.schema_version === expected.schema_version &&
    evidence.owner_package === expected.owner_package &&
    evidence.harness === expected.harness &&
    evidence.resource_type === expected.resource_type &&
    evidence.name === expected.name &&
    evidence.url === expected.url &&
    evidence.oauth_client_id === expected.oauth_client_id
  );
}

function verifyRemoteConfig(mcpEntry) {
  if (!mcpEntry || typeof mcpEntry !== "object") {
    return { ok: false, code: FAILURE_REMOTE_CONFIG_INVALID, message: "Missing implant MCP entry" };
  }

  const fingerprint = verifyRemoteFingerprint(mcpEntry);
  if (!fingerprint.ok) {
    return {
      ok: false,
      code: FAILURE_REMOTE_CONFIG_INVALID,
      message: "The existing implant MCP is not the installer-owned canonical endpoint",
      observed: fingerprint.observed,
      expected: fingerprint.expected
    };
  }

  const scopeValues = normalizeScopes(
    mcpEntry.scopes ?? mcpEntry.oauth?.scopes ?? mcpEntry.oauth_scopes
  );
  const expectedScopes = normalizeScopes(REMOTE_MCP.oauth.scopes);
  const callbackPort = extractCallbackPort(mcpEntry);
  const authState =
    mcpEntry.authenticated ??
    mcpEntry.oauth?.authenticated ??
    mcpEntry.auth?.authenticated ??
    mcpEntry.auth_state ??
    null;

  if (scopeValues.length && scopeValues.sort().join(" ") !== expectedScopes.sort().join(" ")) {
    return { ok: false, code: FAILURE_REMOTE_CONFIG_INVALID, message: "Unexpected implant OAuth scopes" };
  }

  if (callbackPort !== null && callbackPort !== REMOTE_MCP.oauth.codex.callbackPort) {
    return { ok: false, code: FAILURE_REMOTE_CONFIG_INVALID, message: "Unexpected implant OAuth callback port" };
  }

  const probeReasons = [];
  if (!scopeValues.length) {
    probeReasons.push("scope_set_unobservable");
  }
  if (fingerprint.observed.oauth_client_id === null) {
    probeReasons.push("oauth_client_id_unobservable");
  }
  if (callbackPort === null) {
    probeReasons.push("callback_policy_unobservable");
  }
  if (authState === null) {
    probeReasons.push("auth_state_unobservable");
  } else if (authState !== true) {
    probeReasons.push("session_not_authenticated");
  }

  return {
    ok: true,
    runtime_probe_required: probeReasons.length > 0,
    auth_required: probeReasons.length > 0,
    probe_reasons: probeReasons,
    observed: {
      url: fingerprint.observed.url,
      oauth_client_id: fingerprint.observed.oauth_client_id,
      scopes: scopeValues,
      callback_port: callbackPort,
      auth_state: authState
    }
  };
}

function successResult(harness, details = {}) {
  return {
    harness,
    result: RESULT_PASS,
    code: "OK",
    changed: false,
    warnings: [],
    commands: [],
    next_steps: [],
    details
  };
}

function failureResult(harness, code, message, details = {}) {
  return {
    harness,
    result: RESULT_FAIL,
    code,
    message,
    changed: false,
    warnings: [],
    commands: [],
    next_steps: [],
    details
  };
}

function addWarning(result, code, message, details = {}) {
  result.warnings.push({ code, message, details });
  if (result.result === RESULT_PASS) {
    result.result = RESULT_WARN;
  }
  return result;
}

function failResult(result, code, message, details = {}) {
  result.result = RESULT_FAIL;
  result.code = code;
  result.message = message;
  result.details = { ...result.details, ...details };
  return result;
}

function pushCommand(result, command, args, dryRun) {
  result.commands.push({ command, args: [...args], dry_run: dryRun });
}

async function listMarketplaces(executable, args, deps, commandOptions) {
  const result = await executeCommand(executable, args, deps, { ...commandOptions, allowNonZero: true });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Marketplace list failed");
  }
  return parseJsonOutput(result);
}

async function listPlugins(executable, args, deps, commandOptions) {
  const result = await executeCommand(executable, args, deps, { ...commandOptions, allowNonZero: true });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Plugin list failed");
  }
  return parseJsonOutput(result);
}

function resultText(result) {
  return `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`.trim();
}

function isMissingNamedResource(result, resourceName) {
  if (!result || result.exitCode === 0) {
    return false;
  }
  const escapedName = String(resourceName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = resultText(result);
  return Boolean(
    text &&
    (new RegExp(`(?:not found|does not exist|no .{0,40}(?:named|called))[^\\n]*${escapedName}`, "i").test(text) ||
      new RegExp(`${escapedName}[^\\n]*(?:not found|does not exist)`, "i").test(text))
  );
}

function listPluginConflicts(entries, pluginId, expectedScope = "user") {
  return findPluginEntries(entries, pluginId).filter((entry) => pluginScope(entry) !== expectedScope);
}

function pluginDependsOnMarketplace(entry, marketplaceName) {
  if (!entry || entry.installed === false) {
    return false;
  }
  const id = pluginEntryId(entry);
  return Boolean(
    entry.marketplaceName === marketplaceName ||
    entry.marketplace_name === marketplaceName ||
    (typeof id === "string" && id.endsWith(`@${marketplaceName}`))
  );
}

async function removeMarketplaceRegistration({
  harness,
  detection,
  catalogPath,
  pluginEntries,
  dryRun,
  coworkMode = false
}, deps, commandOptions, result) {
  const withCoworkMode = (args) => coworkMode ? [...args, "--cowork"] : args;
  const listArgs = withCoworkMode(["plugin", "marketplace", "list", "--json"]);
  const removeArgs = harness !== HARNESS_CODEX
    ? ["plugin", "marketplace", "remove", CATALOG_NAME, "--scope", "user"]
    : ["plugin", "marketplace", "remove", CATALOG_NAME, "--json"];
  const nativeRemoveArgs = withCoworkMode(removeArgs);
  pushCommand(result, detection.executable, listArgs, dryRun);

  const marketplaceList = await listMarketplaces(
    detection.executable,
    listArgs,
    deps,
    commandOptions
  );
  const entry = findMarketplaceEntry(marketplaceList, CATALOG_NAME);
  if (!entry) {
    return {
      ok: true,
      safe: true,
      changed: false,
      state: "absent",
      catalog_path: canonicalizePath(catalogPath)
    };
  }

  const verification = harness !== HARNESS_CODEX
    ? verifyClaudeMarketplaceEntry(entry, catalogPath)
    : verifyCodexMarketplaceEntry(entry, catalogPath);
  if (!verification.ok) {
    return {
      ok: true,
      safe: false,
      changed: false,
      state: "conflict",
      code: verification.code,
      message: verification.message,
      observed_path: verification.observed_path ?? verification.observed_root ?? null
    };
  }

  const dependents = normalizePluginEntries(pluginEntries)
    .filter((plugin) => pluginDependsOnMarketplace(plugin, CATALOG_NAME));
  if (dependents.length) {
    return {
      ok: true,
      safe: false,
      changed: false,
      state: "retained_for_dependents",
      code: WARNING_CATALOG_REGISTRATION_RETAINED,
      message: "The agent-university marketplace is still required by installed plugins.",
      dependents: dependents.map((plugin) => pluginEntryId(plugin)).filter(Boolean)
    };
  }

  pushCommand(result, detection.executable, nativeRemoveArgs, dryRun);
  if (dryRun) {
    return {
      ok: true,
      safe: true,
      changed: true,
      state: "would_remove",
      catalog_path: canonicalizePath(catalogPath)
    };
  }

  const removal = await executeCommand(detection.executable, nativeRemoveArgs, deps, {
    ...commandOptions,
    allowNonZero: true
  });
  if (removal.exitCode !== 0) {
    return {
      ok: false,
      safe: false,
      changed: false,
      state: "remove_failed",
      code: FAILURE_COMMAND_FAILED,
      message: resultText(removal) || "Marketplace removal failed",
      command: summarizeCommand(removal)
    };
  }

  const afterList = await listMarketplaces(detection.executable, listArgs, deps, commandOptions);
  if (findMarketplaceEntry(afterList, CATALOG_NAME)) {
    return {
      ok: false,
      safe: false,
      changed: false,
      state: "verification_failed",
      code: FAILURE_COMMAND_FAILED,
      message: "Marketplace registration remains after native removal"
    };
  }

  return {
    ok: true,
    safe: true,
    changed: true,
    state: "removed",
    catalog_path: canonicalizePath(catalogPath)
  };
}

function normalizeMcpServerNames(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        return entry?.name ?? entry?.id ?? null;
      })
      .filter(Boolean)
      .sort();
  }

  if (value && typeof value === "object") {
    return Object.keys(value).sort();
  }

  return [];
}

function verifyClaudePluginIdentity(entry) {
  if (!entry) {
    return { ok: false, code: FAILURE_COMMAND_FAILED, message: "Claude plugin verification failed" };
  }

  if (pluginEntryId(entry) !== PLUGIN_ID) {
    return { ok: false, code: FAILURE_COMMAND_FAILED, message: "Claude plugin identity does not match BIOS Implant" };
  }

  if (pluginScope(entry) !== "user") {
    return { ok: false, code: FAILURE_COMMAND_FAILED, message: "Claude plugin is not installed at user scope" };
  }

  return {
    ok: true,
    details: {
      version: typeof entry.version === "string" ? entry.version : null,
      enabled: entry.enabled ?? null,
      scope: pluginScope(entry),
      mcp_servers: normalizeMcpServerNames(entry.mcpServers)
    }
  };
}

function verifyClaudePlugin(entry) {
  const identity = verifyClaudePluginIdentity(entry);
  if (!identity.ok) {
    return identity;
  }

  if (entry.enabled !== true) {
    return { ok: false, code: FAILURE_COMMAND_FAILED, message: "Claude plugin is not enabled" };
  }

  const observedServers = identity.details.mcp_servers;
  const expectedServers = [REMOTE_MCP.name, "implant-local"].sort();
  if (observedServers.length && observedServers.join(",") !== expectedServers.join(",")) {
    return {
      ok: false,
      code: FAILURE_COMMAND_FAILED,
      message: "Claude plugin MCP inventory does not match the packaged plugin",
      observed_mcp_servers: observedServers
    };
  }

  const version = typeof entry.version === "string" ? entry.version : null;
  if (version && compareSemver(version, PACKAGE_VERSION) < 0) {
    return {
      ok: false,
      code: FAILURE_COMMAND_FAILED,
      message: "Claude plugin version remains below the requested package version"
    };
  }

  return {
    ok: true,
    details: {
      ...identity.details,
      version
    }
  };
}

function verifyCodexPlugin(entry) {
  if (!entry) {
    return { ok: false, code: FAILURE_COMMAND_FAILED, message: "Codex plugin verification failed" };
  }

  const marketplaceName = entry.marketplaceName ?? null;
  if (marketplaceName && marketplaceName !== CATALOG_NAME) {
    return {
      ok: false,
      code: FAILURE_COMMAND_FAILED,
      message: "Codex plugin is installed from an unexpected marketplace"
    };
  }

  const source = entry.source ?? null;
  const sourceKind = typeof source === "string" ? source : source?.source;
  const sourcePackage = typeof source === "object" && source ? source.package : null;
  if (sourceKind !== "npm" || sourcePackage !== PACKAGE_NAME) {
    return {
      ok: false,
      code: FAILURE_COMMAND_FAILED,
      message: "Codex plugin is installed from an unexpected source"
    };
  }

  if (entry.installed === false || entry.enabled === false) {
    return {
      ok: false,
      code: FAILURE_COMMAND_FAILED,
      message: "Codex plugin is not installed and enabled"
    };
  }

  const version = typeof entry.version === "string" ? entry.version : null;
  const needsUpdate = Boolean(version && compareSemver(version, PACKAGE_VERSION) < 0);
  const newerPresent = Boolean(version && compareSemver(version, PACKAGE_VERSION) > 0);

  return {
    ok: true,
    needs_update: needsUpdate,
    newer_present: newerPresent,
    details: {
      version,
      marketplace_name: marketplaceName,
      source: sourceKind,
      source_package: sourcePackage,
      marketplace_source: entry.marketplaceSource ?? null
    }
  };
}

function codexLoginNextStep() {
  return `Complete native OAuth discovery: codex mcp login ${REMOTE_MCP.name}`;
}

function canonicalizePath(value) {
  return typeof value === "string" && value.trim() ? path.resolve(value) : null;
}

function findMarketplaceEntry(entries, name) {
  return normalizeMarketplaceEntries(entries).find((entry) => entry?.name === name) ?? null;
}

function verifyClaudeMarketplaceEntry(entry, catalogPath) {
  if (!entry) {
    return { ok: false, code: FAILURE_COMMAND_FAILED, message: "Claude marketplace verification failed" };
  }

  const observedPath = canonicalizePath(entry.path);
  const expectedPath = canonicalizePath(catalogPath);
  if (observedPath !== expectedPath) {
    return {
      ok: false,
      code: FAILURE_MARKETPLACE_CONFLICT,
      message: "Claude already has an agent-university marketplace registered from a different path",
      observed_path: observedPath
    };
  }

  return {
    ok: true,
    details: {
      name: entry.name,
      path: observedPath,
      source: entry.source ?? null,
      install_location: entry.installLocation ?? null
    }
  };
}

function verifyCodexMarketplaceEntry(entry, catalogPath) {
  if (!entry) {
    return { ok: false, code: FAILURE_COMMAND_FAILED, message: "Codex marketplace verification failed" };
  }

  const observedRoot = canonicalizePath(entry.root);
  const expectedRoot = canonicalizePath(catalogPath);
  if (observedRoot !== expectedRoot) {
    return {
      ok: false,
      code: FAILURE_MARKETPLACE_CONFLICT,
      message: "Codex already has an agent-university marketplace registered from a different path",
      observed_root: observedRoot
    };
  }

  return {
    ok: true,
    details: {
      name: entry.name,
      root: observedRoot,
      marketplace_source: entry.marketplaceSource ?? null
    }
  };
}

async function ensureClaudeMarketplace({
  detection,
  catalogPath,
  dryRun,
  coworkMode = false
}, deps, commandOptions, result) {
  const withCoworkMode = (args) => coworkMode ? [...args, "--cowork"] : args;
  const listArgs = withCoworkMode(["plugin", "marketplace", "list", "--json"]);
  const addArgs = withCoworkMode([
    "plugin",
    "marketplace",
    "add",
    catalogPath,
    "--scope",
    "user"
  ]);

  pushCommand(result, detection.executable, listArgs, dryRun);

  const beforeList = await listMarketplaces(detection.executable, listArgs, deps, commandOptions);
  const beforeEntry = findMarketplaceEntry(beforeList, CATALOG_NAME);
  if (beforeEntry) {
    const verification = verifyClaudeMarketplaceEntry(beforeEntry, catalogPath);
    if (!verification.ok) {
      return verification;
    }
    return {
      ...verification,
      changed: false,
      details: verification.details
    };
  }

  pushCommand(result, detection.executable, addArgs, dryRun);
  if (dryRun) {
    return { ok: true, changed: true, details: null };
  }
  await executeCommand(detection.executable, addArgs, deps, commandOptions);
  const afterList = await listMarketplaces(detection.executable, listArgs, deps, commandOptions);
  const afterEntry = findMarketplaceEntry(afterList, CATALOG_NAME);
  const afterVerification = verifyClaudeMarketplaceEntry(afterEntry, catalogPath);
  return {
    ...afterVerification,
    changed: true,
    details: afterVerification.details ?? null
  };
}

async function ensureCodexMarketplace({ detection, catalogPath, dryRun }, deps, commandOptions, result) {
  const listArgs = ["plugin", "marketplace", "list", "--json"];
  const addArgs = ["plugin", "marketplace", "add", catalogPath, "--json"];

  pushCommand(result, detection.executable, listArgs, dryRun);

  const beforeList = await listMarketplaces(detection.executable, listArgs, deps, commandOptions);
  const beforeEntry = findMarketplaceEntry(beforeList, CATALOG_NAME);
  if (beforeEntry) {
    const verification = verifyCodexMarketplaceEntry(beforeEntry, catalogPath);
    return {
      ...verification,
      changed: false,
      details: verification.details ?? null
    };
  }

  pushCommand(result, detection.executable, addArgs, dryRun);
  if (dryRun) {
    return { ok: true, changed: true, details: null };
  }
  await executeCommand(detection.executable, addArgs, deps, commandOptions);
  const afterList = await listMarketplaces(detection.executable, listArgs, deps, commandOptions);
  const afterEntry = findMarketplaceEntry(afterList, CATALOG_NAME);
  const afterVerification = verifyCodexMarketplaceEntry(afterEntry, catalogPath);
  return {
    ...afterVerification,
    changed: true,
    details: afterVerification.details ?? null
  };
}

export async function installHarness({
  harness,
  detection,
  catalogPath,
  dryRun = false,
  mcpOwnership = null,
  coworkProfile = null,
  npmCachePath = null
}, deps = {}) {
  const requestedHarness = harness;
  const effectiveHarness = harness;
  let commandOptions = { timeoutMs: timeoutMsFor(deps.options ?? {}) };

  if (!detection?.detected) {
    return failureResult(
      requestedHarness,
      FAILURE_HARNESS_NOT_DETECTED,
      `${requestedHarness} was requested but not detected`
    );
  }

  if (requestedHarness === HARNESS_COWORK && !detection.app_present) {
    return failureResult(
      requestedHarness,
      FAILURE_HARNESS_NOT_DETECTED,
      "Claude Desktop / Local Cowork was requested but is not installed"
    );
  }

  if (!detection?.supported || !detection.executable) {
    const failure = failureResult(
      requestedHarness,
      FAILURE_HARNESS_UPGRADE_REQUIRED,
      requestedHarness === HARNESS_COWORK
        ? `Claude CLI ${detection?.required_version ?? COWORK_MIN_VERSION} or newer is required for automatic Local Cowork registration`
        : `${requestedHarness} CLI is required for native registration`,
      {
        observed_version: detection?.version ?? null,
        minimum_version: detection?.required_version ?? null
      }
    );
    if (requestedHarness === HARNESS_COWORK) {
      failure.next_steps.push("Update Claude Desktop and Claude CLI, open Local Cowork once, then rerun installation.");
    }
    return failure;
  }

  if (requestedHarness === HARNESS_COWORK) {
    if (!coworkProfile?.ok || !coworkProfile.config_dir) {
      return failureResult(
        requestedHarness,
        coworkProfile?.code ?? FAILURE_COWORK_PROFILE_NOT_FOUND,
        coworkProfile?.message ?? "No active Claude Desktop Cowork profile was found. Open Local Cowork once, then rerun installation.",
        { cowork_profile: coworkProfile }
      );
    }
    if (!npmCachePath) {
      return failureResult(
        requestedHarness,
        FAILURE_COMMAND_FAILED,
        "A managed npm cache path is required for Cowork plugin installation."
      );
    }
    commandOptions = {
      ...commandOptions,
      env: {
        ...(deps.env ?? process.env),
        CLAUDE_CONFIG_DIR: coworkProfile.config_dir,
        NPM_CONFIG_CACHE: npmCachePath
      }
    };
    return installClaudeHarness({
      harness: requestedHarness,
      detection,
      catalogPath,
      dryRun,
      coworkMode: true,
      coworkProfile
    }, deps, commandOptions);
  }

  if (effectiveHarness === HARNESS_CLAUDE) {
    return installClaudeHarness({ harness: requestedHarness, detection, catalogPath, dryRun }, deps, commandOptions);
  }

  if (effectiveHarness === HARNESS_CODEX) {
    return installCodexHarness({
      harness: requestedHarness,
      detection,
      catalogPath,
      dryRun,
      mcpOwnership
    }, deps, commandOptions);
  }

  return failureResult(requestedHarness, FAILURE_COMMAND_FAILED, `Unsupported harness ${requestedHarness}`);
}

async function installClaudeHarness({
  harness,
  detection,
  catalogPath,
  dryRun,
  coworkMode = false,
  coworkProfile = null
}, deps, commandOptions) {
  const withCoworkMode = (args) => coworkMode ? [...args, "--cowork"] : args;
  const result = successResult(harness, {
    executable: detection.executable,
    version: detection.version,
    ...(coworkMode ? {
      app_present: true,
      registration_state: "reconciling",
      cowork_profile: {
        account_id: coworkProfile.account_id,
        organization_id: coworkProfile.organization_id,
        config_dir: coworkProfile.config_dir,
        source: coworkProfile.source
      }
    } : {})
  });
  const listArgs = withCoworkMode(["plugin", "list", "--json"]);
  const commands = [listArgs];

  for (const args of commands) {
    pushCommand(result, detection.executable, args, dryRun);
  }

  const marketplaceResult = await ensureClaudeMarketplace({
    detection,
    catalogPath,
    dryRun,
    coworkMode
  }, deps, commandOptions, result);
  if (!marketplaceResult.ok) {
    return failureResult(harness, marketplaceResult.code, marketplaceResult.message, {
      marketplace: marketplaceResult.details ?? null,
      observed_path: marketplaceResult.observed_path ?? null,
      install_location: marketplaceResult.install_location ?? null
    });
  }
  result.details = { ...result.details, marketplace: marketplaceResult.details };
  result.changed = result.changed || Boolean(marketplaceResult.changed);

  if (dryRun) {
    const currentList = await listPlugins(detection.executable, listArgs, deps, commandOptions);
    const currentUserEntry = findPluginEntries(currentList, PLUGIN_ID).find((entry) => pluginScope(entry) === "user");
    const currentVerification = currentUserEntry ? verifyClaudePlugin(currentUserEntry) : null;
    const explicitConflicts = listPluginConflicts(currentList, PLUGIN_ID);
    if (!currentVerification?.ok) {
      result.changed = true;
    } else {
      const currentVersion = currentUserEntry.version ?? null;
      if (currentVersion && compareSemver(currentVersion, PACKAGE_VERSION) < 0) {
        result.changed = true;
      }
      if (currentVersion && compareSemver(currentVersion, PACKAGE_VERSION) > 0) {
        addWarning(
          result,
          WARNING_NEWER_VERSION_PRESENT,
          "Claude already has a newer BIOS Implant build.",
          { installed_version: currentVersion, target_version: PACKAGE_VERSION }
        );
      }
    }
    if (explicitConflicts.length) {
      addWarning(
        result,
        WARNING_SCOPE_CONFLICT,
        "A non-user BIOS Implant Claude install is still present and may shadow the canonical user-scope install.",
        {
          scopes: explicitConflicts.map((entry) => pluginScope(entry))
        }
      );
    }
    result.code = "DRY_RUN";
    result.next_steps.push(`Run install without --dry-run to reconcile ${harness}.`);
    return result;
  }

  const beforeList = await listPlugins(detection.executable, listArgs, deps, commandOptions);
  const installed = findPluginEntries(beforeList, PLUGIN_ID).find((entry) => pluginScope(entry) === "user");

  if (!installed) {
    const installArgs = withCoworkMode(["plugin", "install", PLUGIN_ID, "--scope", "user"]);
    pushCommand(result, detection.executable, installArgs, false);
    await executeCommand(detection.executable, installArgs, deps, commandOptions);
    result.changed = true;
  } else {
    const currentVersion = installed.version ?? null;
    if (currentVersion && compareSemver(currentVersion, PACKAGE_VERSION) > 0) {
      addWarning(
        result,
        WARNING_NEWER_VERSION_PRESENT,
        "Claude already has a newer BIOS Implant build.",
        { installed_version: currentVersion, target_version: PACKAGE_VERSION }
      );
    } else if (currentVersion && compareSemver(currentVersion, PACKAGE_VERSION) < 0) {
      const updateArgs = withCoworkMode(["plugin", "update", PLUGIN_ID, "--scope", "user"]);
      pushCommand(result, detection.executable, updateArgs, false);
      await executeCommand(detection.executable, updateArgs, deps, commandOptions);
      result.changed = true;
    }
  }

  const afterList = await listPlugins(detection.executable, listArgs, deps, commandOptions);
  const verified = findPluginEntries(afterList, PLUGIN_ID).find((entry) => pluginScope(entry) === "user");
  const verification = verifyClaudePlugin(verified);
  if (!verification.ok) {
    const conflictingInstall = listPluginConflicts(afterList, PLUGIN_ID);
    return failureResult(harness, verification.code, verification.message, {
      conflicts: conflictingInstall.map((entry) => ({ scope: pluginScope(entry), enabled: entry.enabled ?? null }))
    });
  }
  result.details = { ...result.details, ...verification.details };
  if (coworkMode) {
    result.details.registration_state = "installed_and_verified";
  }

  const explicitConflicts = listPluginConflicts(afterList, PLUGIN_ID);
  if (explicitConflicts.length) {
    addWarning(
      result,
      WARNING_SCOPE_CONFLICT,
      "A non-user BIOS Implant Claude install is still present and may shadow the canonical user-scope install.",
      {
        scopes: explicitConflicts.map((entry) => pluginScope(entry))
      }
    );
  }

  addWarning(
    result,
    WARNING_RUNTIME_PROBE_REQUIRED,
    "Claude installation is configured, but authenticated runtime health must be verified from a new session."
  );
  result.next_steps.push(coworkMode
    ? "Open a new Local Cowork session and run the BIOS Implant doctor skill."
    : "Open a new Claude Local Cowork or Claude Code session and run the doctor skill.");
  return result;
}

async function installCodexHarness({
  harness,
  detection,
  catalogPath,
  dryRun,
  mcpOwnership
}, deps, commandOptions) {
  const result = successResult(harness, {
    executable: detection.executable,
    version: detection.version
  });

  const marketplaceResult = await ensureCodexMarketplace({ detection, catalogPath, dryRun }, deps, commandOptions, result);
  if (!marketplaceResult.ok) {
    return failureResult(harness, marketplaceResult.code, marketplaceResult.message, {
      marketplace: marketplaceResult.details ?? null,
      observed_root: marketplaceResult.observed_root ?? null
    });
  }
  result.details = { ...result.details, marketplace: marketplaceResult.details };
  result.changed = result.changed || Boolean(marketplaceResult.changed);

  const pluginListArgs = ["plugin", "list", "--json"];
  pushCommand(result, detection.executable, pluginListArgs, dryRun);
  const beforePluginList = await listPlugins(
    detection.executable,
    pluginListArgs,
    deps,
    commandOptions
  );
  const beforePlugin = findPluginEntry(beforePluginList, PLUGIN_ID);
  const beforePluginVerification = beforePlugin ? verifyCodexPlugin(beforePlugin) : null;
  if (beforePlugin && !beforePluginVerification?.ok) {
    return failResult(
      result,
      beforePluginVerification.code,
      "A conflicting Codex BIOS Implant plugin entry was preserved.",
      { plugin_conflict: { id: pluginEntryId(beforePlugin), preserved: true } }
    );
  }
  if (beforePluginVerification?.newer_present) {
    addWarning(
      result,
      WARNING_NEWER_VERSION_PRESENT,
      "Codex already has a newer BIOS Implant build.",
      { installed_version: beforePluginVerification.details.version, target_version: PACKAGE_VERSION }
    );
  } else if (!beforePlugin || beforePluginVerification.needs_update) {
    const addPluginArgs = ["plugin", "add", PLUGIN_ID, "--json"];
    pushCommand(result, detection.executable, addPluginArgs, dryRun);
    if (!dryRun) {
      await executeCommand(detection.executable, addPluginArgs, deps, commandOptions);
    }
    result.changed = true;
  }

  const mcpGetArgs = ["mcp", "get", REMOTE_MCP.name, "--json"];
  pushCommand(result, detection.executable, mcpGetArgs, dryRun);
  const mcpBefore = await executeCommand(
    detection.executable,
    mcpGetArgs,
    deps,
    { ...commandOptions, allowNonZero: true }
  );
  const mcpMissing = isMissingNamedResource(mcpBefore, REMOTE_MCP.name);
  if (mcpBefore.exitCode !== 0 && !mcpMissing) {
    return failResult(
      result,
      FAILURE_COMMAND_FAILED,
      "Could not determine whether the Codex implant MCP already exists; no MCP changes were made.",
      { mcp_probe: summarizeCommand(mcpBefore), error: resultText(mcpBefore) }
    );
  }
  const mcpBeforeJson = mcpBefore.exitCode === 0 ? parseJsonOutput(mcpBefore) : null;
  const mcpBeforeEntry = mcpBeforeJson?.server ?? mcpBeforeJson;
  const mcpBeforeVerification = mcpBefore.exitCode === 0
    ? verifyRemoteConfig(mcpBeforeEntry)
    : null;
  if (mcpBefore.exitCode === 0 && !mcpBeforeVerification?.ok) {
    const fingerprint = verifyRemoteFingerprint(mcpBeforeEntry);
    const failed = failResult(
      result,
      mcpBeforeVerification.code,
      "The same-name Codex implant MCP conflicts with the canonical configuration and was preserved.",
      {
        mcp_conflict: {
          preserved: true,
          ownership_recorded: hasCanonicalMcpOwnership(mcpOwnership),
          fingerprint: fingerprint.observed,
          expected: fingerprint.expected
        }
      }
    );
    failed.next_steps.push(
      `Resolve or rename the existing '${REMOTE_MCP.name}' MCP entry, then rerun installation.`
    );
    return failed;
  }

  let mcpCreated = false;
  if (mcpMissing) {
    const addArgs = ["mcp", "add", REMOTE_MCP.name, "--url", REMOTE_MCP.url, "--oauth-client-id", REMOTE_MCP.oauth.clientId];
    pushCommand(result, detection.executable, addArgs, dryRun);
    if (!dryRun) {
      await executeCommand(detection.executable, addArgs, deps, commandOptions);
      mcpCreated = true;
    }
    result.changed = true;
  }

  if (dryRun) {
    if (mcpBeforeVerification?.auth_required) {
      addWarning(
        result,
        WARNING_AUTH_REQUIRED,
        "Codex owns OAuth discovery for this MCP; scopes, callback policy, and session auth are not fully observable.",
        { reasons: mcpBeforeVerification.probe_reasons, next_step: codexLoginNextStep() }
      );
    }
    result.code = "DRY_RUN";
    result.next_steps.push("Run install without --dry-run to reconcile Codex.");
    return result;
  }

  pushCommand(result, detection.executable, pluginListArgs, false);
  const pluginList = await listPlugins(detection.executable, pluginListArgs, deps, commandOptions);
  const codexPlugin = findPluginEntry(pluginList, PLUGIN_ID);
  const pluginVerification = verifyCodexPlugin(codexPlugin);
  if (!pluginVerification.ok) {
    return failureResult(harness, pluginVerification.code, pluginVerification.message);
  }
  result.details = { ...result.details, ...pluginVerification.details };

  pushCommand(result, detection.executable, mcpGetArgs, false);
  const mcpAfter = await executeCommand(
    detection.executable,
    mcpGetArgs,
    deps,
    { ...commandOptions, allowNonZero: true }
  );
  if (mcpAfter.exitCode !== 0) {
    return failureResult(harness, FAILURE_COMMAND_FAILED, "Codex implant MCP verification failed");
  }

  const mcpConfig = parseJsonOutput(mcpAfter);
  const remoteVerification = verifyRemoteConfig(mcpConfig?.server ?? mcpConfig);
  if (!remoteVerification.ok) {
    return failureResult(harness, remoteVerification.code, remoteVerification.message, {
      observed: mcpConfig
    });
  }

  result.details = {
    ...result.details,
    implant_mcp: remoteVerification.observed,
    mcp_ownership_recorded: hasCanonicalMcpOwnership(mcpOwnership)
  };
  if (mcpCreated) {
    result.details.mcp_ownership = canonicalMcpOwnershipEvidence();
    result.details.mcp_created_by_installer = true;
  }
  if (remoteVerification.auth_required) {
    addWarning(
      result,
      WARNING_AUTH_REQUIRED,
      "Codex implant MCP is configured; native OAuth discovery/session must confirm scopes, callback policy, and authentication.",
      {
        reasons: remoteVerification.probe_reasons,
        next_step: codexLoginNextStep()
      }
    );
    result.next_steps.push("Open a new Codex session and run the doctor flow.");
    result.next_steps.push(codexLoginNextStep());
    return result;
  }

  result.next_steps.push("Open a new Codex session and run the doctor flow.");
  return result;
}

export async function uninstallHarness({
  harness,
  detection,
  catalogPath,
  dryRun = false,
  mcpOwnership = null,
  coworkProfile = null,
  npmCachePath = null
}, deps = {}) {
  const requestedHarness = harness;
  const effectiveHarness = harness;
  let commandOptions = { timeoutMs: timeoutMsFor(deps.options ?? {}) };

  if (!detection?.detected) {
    return failureResult(
      requestedHarness,
      FAILURE_HARNESS_NOT_DETECTED,
      `${requestedHarness} was requested but not detected`
    );
  }

  if (requestedHarness === HARNESS_COWORK && !detection.app_present) {
    return failureResult(
      requestedHarness,
      FAILURE_HARNESS_NOT_DETECTED,
      "Claude Desktop / Local Cowork was requested but is not installed"
    );
  }

  if (!detection?.supported || !detection.executable) {
    const failure = failureResult(
      requestedHarness,
      FAILURE_HARNESS_UPGRADE_REQUIRED,
      requestedHarness === HARNESS_COWORK
        ? `Claude CLI ${detection?.required_version ?? COWORK_MIN_VERSION} or newer is required for automatic Local Cowork removal`
        : `${requestedHarness} CLI is required for native removal`,
      {
        observed_version: detection?.version ?? null,
        minimum_version: detection?.required_version ?? null
      }
    );
    if (requestedHarness === HARNESS_COWORK) {
      failure.next_steps.push("Update Claude Desktop and Claude CLI, open Local Cowork once, then rerun uninstall.");
    }
    return failure;
  }

  if (requestedHarness === HARNESS_COWORK) {
    if (!coworkProfile?.ok || !coworkProfile.config_dir) {
      return failureResult(
        requestedHarness,
        coworkProfile?.code ?? FAILURE_COWORK_PROFILE_NOT_FOUND,
        coworkProfile?.message ?? "No active Claude Desktop Cowork profile was found. Open Local Cowork once, then rerun uninstall.",
        { cowork_profile: coworkProfile }
      );
    }
    commandOptions = {
      ...commandOptions,
      env: {
        ...(deps.env ?? process.env),
        CLAUDE_CONFIG_DIR: coworkProfile.config_dir,
        ...(npmCachePath ? { NPM_CONFIG_CACHE: npmCachePath } : {})
      }
    };
    return uninstallClaudeHarness({
      harness: requestedHarness,
      detection,
      catalogPath,
      dryRun,
      coworkMode: true,
      coworkProfile
    }, deps, commandOptions);
  }

  if (effectiveHarness === HARNESS_CLAUDE) {
    return uninstallClaudeHarness({
      harness: requestedHarness,
      detection,
      catalogPath,
      dryRun
    }, deps, commandOptions);
  }

  if (effectiveHarness === HARNESS_CODEX) {
    return uninstallCodexHarness({
      harness: requestedHarness,
      detection,
      catalogPath,
      dryRun,
      mcpOwnership
    }, deps, commandOptions);
  }

  return failureResult(requestedHarness, FAILURE_COMMAND_FAILED, `Unsupported harness ${requestedHarness}`);
}

async function uninstallClaudeHarness({
  harness,
  detection,
  catalogPath,
  dryRun,
  coworkMode = false,
  coworkProfile = null
}, deps, commandOptions) {
  const withCoworkMode = (args) => coworkMode ? [...args, "--cowork"] : args;
  const result = successResult(harness, {
    executable: detection.executable,
    version: detection.version,
    ...(coworkMode ? {
      cowork_profile: {
        account_id: coworkProfile.account_id,
        organization_id: coworkProfile.organization_id,
        config_dir: coworkProfile.config_dir,
        source: coworkProfile.source
      }
    } : {})
  });
  const listArgs = withCoworkMode(["plugin", "list", "--json"]);
  const uninstallArgs = withCoworkMode([
    "plugin",
    "uninstall",
    PLUGIN_ID,
    "--scope",
    "user",
    "--yes"
  ]);
  pushCommand(result, detection.executable, listArgs, dryRun);
  const beforeList = await listPlugins(detection.executable, listArgs, deps, commandOptions);
  const beforeEntries = normalizePluginEntries(beforeList);
  const installed = findPluginEntries(beforeList, PLUGIN_ID)
    .find((entry) => pluginScope(entry) === "user") ?? null;
  let pluginEntriesAfter = beforeEntries;

  if (installed) {
    const verification = verifyClaudePluginIdentity(installed);
    if (!verification.ok) {
      return failResult(
        result,
        verification.code,
        "The Claude BIOS Implant entry could not be proven canonical and was preserved.",
        { plugin_removal: { safe: false, state: "conflict", preserved: true } }
      );
    }

    pushCommand(result, detection.executable, uninstallArgs, dryRun);
    if (dryRun) {
      pluginEntriesAfter = beforeEntries.filter((entry) => entry !== installed);
      result.changed = true;
    } else {
      const removal = await executeCommand(detection.executable, uninstallArgs, deps, {
        ...commandOptions,
        allowNonZero: true
      });
      if (removal.exitCode !== 0) {
        return failResult(
          result,
          FAILURE_COMMAND_FAILED,
          resultText(removal) || "Claude plugin uninstall failed",
          { plugin_removal: { safe: false, state: "remove_failed", command: summarizeCommand(removal) } }
        );
      }
      pushCommand(result, detection.executable, listArgs, false);
      const afterList = await listPlugins(detection.executable, listArgs, deps, commandOptions);
      pluginEntriesAfter = normalizePluginEntries(afterList);
      if (findPluginEntries(afterList, PLUGIN_ID).some((entry) => pluginScope(entry) === "user")) {
        return failResult(
          result,
          FAILURE_COMMAND_FAILED,
          "Claude plugin remains after native uninstall",
          { plugin_removal: { safe: false, state: "verification_failed" } }
        );
      }
      result.changed = true;
    }
  }

  result.details.plugin_removal = {
    safe: true,
    state: installed ? (dryRun ? "would_remove" : "removed") : "absent",
    changed: Boolean(installed)
  };
  const catalogRemoval = await removeMarketplaceRegistration({
    harness,
    detection,
    catalogPath,
    pluginEntries: pluginEntriesAfter,
    dryRun,
    coworkMode
  }, deps, commandOptions, result);
  result.details.catalog_removal = catalogRemoval;
  result.changed = result.changed || Boolean(catalogRemoval.changed);
  if (!catalogRemoval.ok) {
    return failResult(
      result,
      catalogRemoval.code ?? FAILURE_COMMAND_FAILED,
      catalogRemoval.message ?? "Claude marketplace removal failed"
    );
  }
  if (!catalogRemoval.safe) {
    addWarning(
      result,
      catalogRemoval.code ?? WARNING_CATALOG_REGISTRATION_RETAINED,
      catalogRemoval.message ?? "Claude marketplace registration was retained.",
      catalogRemoval
    );
  }
  result.details.cleanup_safe = Boolean(catalogRemoval.safe);
  if (dryRun) {
    result.code = "DRY_RUN";
  }
  return result;
}

async function uninstallCodexHarness({
  harness,
  detection,
  catalogPath,
  dryRun,
  mcpOwnership
}, deps, commandOptions) {
  const result = successResult(harness, {
    executable: detection.executable,
    version: detection.version
  });
  const pluginListArgs = ["plugin", "list", "--json"];
  const pluginArgs = ["plugin", "remove", PLUGIN_ID, "--json"];
  const mcpGetArgs = ["mcp", "get", REMOTE_MCP.name, "--json"];
  const mcpArgs = ["mcp", "remove", REMOTE_MCP.name];
  pushCommand(result, detection.executable, pluginListArgs, dryRun);
  const beforePluginList = await listPlugins(
    detection.executable,
    pluginListArgs,
    deps,
    commandOptions
  );
  const beforePluginEntries = normalizePluginEntries(beforePluginList);
  const pluginEntry = findPluginEntry(beforePluginList, PLUGIN_ID);
  let pluginEntriesAfter = beforePluginEntries;

  if (pluginEntry) {
    const verification = verifyCodexPlugin(pluginEntry);
    if (!verification.ok) {
      return failResult(
        result,
        verification.code,
        "The Codex BIOS Implant entry could not be proven canonical and was preserved.",
        { plugin_removal: { safe: false, state: "conflict", preserved: true } }
      );
    }

    pushCommand(result, detection.executable, pluginArgs, dryRun);
    if (dryRun) {
      pluginEntriesAfter = beforePluginEntries.filter((entry) => entry !== pluginEntry);
      result.changed = true;
    } else {
      const removal = await executeCommand(detection.executable, pluginArgs, deps, {
        ...commandOptions,
        allowNonZero: true
      });
      if (removal.exitCode !== 0) {
        return failResult(
          result,
          FAILURE_COMMAND_FAILED,
          resultText(removal) || "Codex plugin removal failed",
          { plugin_removal: { safe: false, state: "remove_failed", command: summarizeCommand(removal) } }
        );
      }
      pushCommand(result, detection.executable, pluginListArgs, false);
      const afterPluginList = await listPlugins(
        detection.executable,
        pluginListArgs,
        deps,
        commandOptions
      );
      pluginEntriesAfter = normalizePluginEntries(afterPluginList);
      if (findPluginEntry(afterPluginList, PLUGIN_ID)) {
        return failResult(
          result,
          FAILURE_COMMAND_FAILED,
          "Codex plugin remains after native removal",
          { plugin_removal: { safe: false, state: "verification_failed" } }
        );
      }
      result.changed = true;
    }
  }
  result.details.plugin_removal = {
    safe: true,
    state: pluginEntry ? (dryRun ? "would_remove" : "removed") : "absent",
    changed: Boolean(pluginEntry)
  };

  pushCommand(result, detection.executable, mcpGetArgs, dryRun);
  const mcpBefore = await executeCommand(detection.executable, mcpGetArgs, deps, {
    ...commandOptions,
    allowNonZero: true
  });
  const mcpMissing = isMissingNamedResource(mcpBefore, REMOTE_MCP.name);
  if (mcpBefore.exitCode !== 0 && !mcpMissing) {
    return failResult(
      result,
      FAILURE_COMMAND_FAILED,
      "Could not verify the Codex implant MCP before uninstall; it was not modified.",
      { mcp_removal: { safe: false, state: "probe_failed", command: summarizeCommand(mcpBefore) } }
    );
  }

  let mcpRemoval = { safe: true, state: "absent", changed: false };
  if (mcpBefore.exitCode === 0) {
    const mcpJson = parseJsonOutput(mcpBefore);
    const mcpEntry = mcpJson?.server ?? mcpJson;
    const fingerprint = verifyRemoteFingerprint(mcpEntry);
    const owned = hasCanonicalMcpOwnership(mcpOwnership);
    if (!owned || !fingerprint.ok) {
      mcpRemoval = {
        safe: false,
        state: "preserved_unproven",
        changed: false,
        preserved: true,
        ownership_recorded: owned,
        observed: fingerprint.observed,
        expected: fingerprint.expected
      };
      addWarning(
        result,
        WARNING_MCP_OWNERSHIP_CONFLICT,
        "The same-name Codex implant MCP was preserved because installer ownership and the canonical fingerprint could not both be proven.",
        mcpRemoval
      );
      result.next_steps.push(
        `Review '${REMOTE_MCP.name}' with 'codex mcp get ${REMOTE_MCP.name} --json' and remove it manually only if it is yours.`
      );
    } else {
      pushCommand(result, detection.executable, mcpArgs, dryRun);
      if (dryRun) {
        mcpRemoval = { safe: true, state: "would_remove", changed: true };
        result.changed = true;
      } else {
        const removal = await executeCommand(detection.executable, mcpArgs, deps, {
          ...commandOptions,
          allowNonZero: true
        });
        if (removal.exitCode !== 0) {
          return failResult(
            result,
            FAILURE_COMMAND_FAILED,
            resultText(removal) || "Codex MCP removal failed",
            { mcp_removal: { safe: false, state: "remove_failed", command: summarizeCommand(removal) } }
          );
        }
        pushCommand(result, detection.executable, mcpGetArgs, false);
        const mcpAfter = await executeCommand(detection.executable, mcpGetArgs, deps, {
          ...commandOptions,
          allowNonZero: true
        });
        if (mcpAfter.exitCode === 0) {
          return failResult(
            result,
            FAILURE_COMMAND_FAILED,
            "Codex implant MCP remains after native removal",
            { mcp_removal: { safe: false, state: "verification_failed" } }
          );
        }
        if (!isMissingNamedResource(mcpAfter, REMOTE_MCP.name)) {
          return failResult(
            result,
            FAILURE_COMMAND_FAILED,
            "Codex MCP post-removal verification failed",
            { mcp_removal: { safe: false, state: "verification_error", command: summarizeCommand(mcpAfter) } }
          );
        }
        mcpRemoval = { safe: true, state: "removed", changed: true };
        result.changed = true;
      }
    }
  }
  result.details.mcp_removal = mcpRemoval;

  const catalogRemoval = await removeMarketplaceRegistration({
    harness: HARNESS_CODEX,
    detection,
    catalogPath,
    pluginEntries: pluginEntriesAfter,
    dryRun
  }, deps, commandOptions, result);
  result.details.catalog_removal = catalogRemoval;
  result.changed = result.changed || Boolean(catalogRemoval.changed);
  if (!catalogRemoval.ok) {
    return failResult(
      result,
      catalogRemoval.code ?? FAILURE_COMMAND_FAILED,
      catalogRemoval.message ?? "Codex marketplace removal failed"
    );
  }
  if (!catalogRemoval.safe) {
    addWarning(
      result,
      catalogRemoval.code ?? WARNING_CATALOG_REGISTRATION_RETAINED,
      catalogRemoval.message ?? "Codex marketplace registration was retained.",
      catalogRemoval
    );
  }
  result.details.cleanup_safe = Boolean(mcpRemoval.safe && catalogRemoval.safe);
  if (dryRun) {
    result.code = "DRY_RUN";
  }
  return result;
}

export async function doctorHarness({ harness, detection }, deps = {}) {
  const effectiveHarness = harness;

  if (!detection?.detected) {
    return {
      harness,
      result: RESULT_FAIL,
      code: FAILURE_HARNESS_NOT_DETECTED,
      message: `${harness} not detected.`,
      checks: [
        {
          code: FAILURE_HARNESS_NOT_DETECTED,
          result: RESULT_FAIL,
          evidence: { requested_harness: harness }
        }
      ]
    };
  }

  if (harness === HARNESS_COWORK) {
    if (!detection.app_present) {
      return {
        harness,
        result: RESULT_FAIL,
        code: FAILURE_HARNESS_NOT_DETECTED,
        message: "Claude Desktop / Local Cowork is not installed.",
        checks: [{
          code: FAILURE_HARNESS_NOT_DETECTED,
          result: RESULT_FAIL,
          evidence: { app_present: false }
        }]
      };
    }
    const inspect = deps.inspectCoworkInstallation ?? inspectCoworkInstallation;
    const inspection = await inspect({
      homeDirectory: deps.homeDirectory ?? deps.env?.HOME ?? os.homedir(),
      platform: deps.platform ?? process.platform,
      env: deps.env ?? process.env,
      fileSystem: deps.fs ?? fsp
    });
    const observed = inspection.installed === true;
    return {
      harness,
      result: RESULT_WARN,
      code: observed ? COWORK_PLUGIN_OBSERVED : COWORK_PLUGIN_NOT_OBSERVED,
      message: observed
        ? "BIOS Implant is observed in Local Cowork state."
        : "BIOS Implant is not yet observable in Local Cowork state.",
      checks: [{
        code: observed ? COWORK_PLUGIN_OBSERVED : COWORK_PLUGIN_NOT_OBSERVED,
        result: RESULT_WARN,
        evidence: {
          ...inspection,
          next_action: observed
            ? "Open a new Local Cowork session and run the installed doctor skill to verify the active profile and runtime."
            : "Run the Cowork installer and approve the native plugin installation."
        }
      }]
    };
  }

  if (detection.upgrade_required || !detection.supported || !detection.executable) {
    return {
      harness,
      result: RESULT_FAIL,
      code: FAILURE_HARNESS_UPGRADE_REQUIRED,
      message: `${harness} native CLI is unavailable.`,
      checks: [
        {
          code: FAILURE_HARNESS_UPGRADE_REQUIRED,
          result: RESULT_FAIL,
          evidence: {
            observed_version: detection.version ?? null,
            minimum_version: detection.required_version ?? null
          }
        }
      ]
    };
  }

  if (effectiveHarness === HARNESS_CLAUDE) {
    const result = await doctorClaudeHarness({ detection }, deps);
    result.harness = harness;
    return result;
  }

  if (effectiveHarness === HARNESS_CODEX) {
    const result = await doctorCodexHarness({ detection }, deps);
    result.harness = harness;
    return result;
  }

  return {
    harness,
    result: RESULT_FAIL,
    code: FAILURE_COMMAND_FAILED,
    message: `Unsupported harness ${harness}`,
    checks: []
  };
}

async function doctorClaudeHarness({ detection }, deps) {
  const commandOptions = { timeoutMs: timeoutMsFor(deps.options ?? {}) };
  const pluginList = await listPlugins(detection.executable, ["plugin", "list", "--json"], deps, commandOptions);
  const pluginEntry = findPluginEntries(pluginList, PLUGIN_ID).find((entry) => pluginScope(entry) === "user");
  const verification = verifyClaudePlugin(pluginEntry);
  const explicitConflicts = listPluginConflicts(pluginList, PLUGIN_ID);
  const check = verification.ok
    ? {
        code: "CLAUDE_PLUGIN_PRESENT",
        result: explicitConflicts.length ? RESULT_WARN : RESULT_PASS,
        evidence: {
          executable: detection.executable,
          version: detection.version,
          plugin_version: pluginEntry.version ?? null,
          scope: pluginScope(pluginEntry),
          enabled: pluginEntry.enabled ?? null,
          mcp_servers: normalizeMcpServerNames(pluginEntry.mcpServers)
        }
      }
    : {
        code: "CLAUDE_PLUGIN_MISSING",
        result: RESULT_FAIL,
        evidence: {
          executable: detection.executable,
          version: detection.version
        }
      };

  const checks = [check];
  if (explicitConflicts.length) {
    checks.push({
      code: WARNING_SCOPE_CONFLICT,
      result: RESULT_WARN,
      evidence: {
        scopes: explicitConflicts.map((entry) => pluginScope(entry))
      }
    });
  }

  return {
    harness: HARNESS_CLAUDE,
    result: checks.some((entry) => entry.result === RESULT_FAIL)
      ? RESULT_FAIL
      : checks.some((entry) => entry.result === RESULT_WARN)
        ? RESULT_WARN
        : RESULT_PASS,
    code: check.code,
    message: check.result === RESULT_FAIL ? "Claude plugin missing." : "Claude plugin present.",
    checks
  };
}

async function doctorCodexHarness({ detection }, deps) {
  const commandOptions = { timeoutMs: timeoutMsFor(deps.options ?? {}) };
  const pluginList = await listPlugins(detection.executable, ["plugin", "list", "--json"], deps, commandOptions);
  const pluginEntry = findPluginEntry(pluginList, PLUGIN_ID);
  const pluginVerification = verifyCodexPlugin(pluginEntry);
  const mcpResult = await executeCommand(
    detection.executable,
    ["mcp", "get", REMOTE_MCP.name, "--json"],
    deps,
    { ...commandOptions, allowNonZero: true }
  );
  const mcpJson = mcpResult.exitCode === 0 ? parseJsonOutput(mcpResult) : null;
  const mcpVerification = mcpResult.exitCode === 0 ? verifyRemoteConfig(mcpJson?.server ?? mcpJson) : null;

  const checks = [];
  checks.push(
    pluginVerification.ok
      ? {
          code: "CODEX_PLUGIN_PRESENT",
          result: RESULT_PASS,
          evidence: {
            executable: detection.executable,
            version: detection.version,
            marketplace_name: pluginEntry.marketplaceName ?? null,
            source: pluginEntry.source ?? null
          }
        }
      : {
          code: "CODEX_PLUGIN_MISSING",
          result: RESULT_FAIL,
          evidence: {
            executable: detection.executable,
            version: detection.version
          }
        }
  );
  checks.push(
    mcpResult.exitCode !== 0
      ? {
          code: "CODEX_MCP_MISSING",
          result: RESULT_FAIL,
          evidence: summarizeCommand(mcpResult)
        }
      : !mcpVerification.ok
        ? {
            code: mcpVerification.code,
            result: RESULT_FAIL,
            evidence: mcpJson
          }
        : mcpVerification.runtime_probe_required
        ? {
            code: WARNING_RUNTIME_PROBE_REQUIRED,
            result: RESULT_WARN,
            evidence: {
              ...mcpVerification.observed,
              next_action: "Run the in-harness doctor skill or native login flow to confirm the exact OAuth scope set."
            }
          }
        : {
            code: "CODEX_MCP_PRESENT",
            result: RESULT_PASS,
            evidence: mcpVerification.observed
          }
  );

  const failed = checks.find((check) => check.result === RESULT_FAIL);
  const warned = checks.find((check) => check.result === RESULT_WARN);
  return {
    harness: HARNESS_CODEX,
    result: failed ? RESULT_FAIL : warned ? RESULT_WARN : RESULT_PASS,
    code: failed?.code ?? warned?.code ?? "CODEX_OK",
    message: failed ? "Codex verification failed." : warned ? "Codex requires a runtime probe." : "Codex plugin and MCP present.",
    checks
  };
}

export function aggregateHarnessExitCode(results) {
  const hasFailure = results.some((result) => result.result === RESULT_FAIL);
  const hasWarning = results.some((result) => result.result === RESULT_WARN);

  if (hasFailure) {
    return EXIT_INSTALL_FAILURE;
  }

  if (hasWarning) {
    return EXIT_DOCTOR_PARTIAL;
  }

  return 0;
}

export function requestedHarnessRepairCommand(baseCommand, failedHarnesses) {
  const harnessFlags = failedHarnesses.map((harness) => `--harness ${harness}`).join(" ");
  return `${baseCommand} ${harnessFlags}`.trim();
}

export function sanitizeHarnessError(error) {
  return {
    result: RESULT_FAIL,
    code: FAILURE_COMMAND_FAILED,
    message: safeErrorMessage(error)
  };
}

export function selectRequestedHarnesses(requestedHarnesses, detectionResult) {
  return getRequestedHarnesses(requestedHarnesses, detectionResult);
}
