import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PACKAGE_NAME, REMOTE_MCP } from "./constants.mjs";

const CONFIG_FILENAME = "config.toml";
const MANAGED_MARKER = `# Managed by ${PACKAGE_NAME}: fixed callback for the static BIOS Implant OAuth client`;
const CALLBACK_PORT_KEY = "mcp_oauth_callback_port";
const CALLBACK_URL_KEY = "mcp_oauth_callback_url";

const EXPECTED_VALUES = Object.freeze({
  [CALLBACK_PORT_KEY]: REMOTE_MCP.oauth.codex.callbackPort,
  [CALLBACK_URL_KEY]: REMOTE_MCP.oauth.codex.callbackUrl
});

function codexHomeFrom(homeDirectory, env = process.env) {
  const configured = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.join(homeDirectory ?? os.homedir(), ".codex");
}

function configPathFrom(homeDirectory, env) {
  return path.join(codexHomeFrom(homeDirectory, env), CONFIG_FILENAME);
}

function isSectionHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/u.test(line);
}

function rootLines(source) {
  const lines = source.split(/\r?\n/u);
  const firstSection = lines.findIndex(isSectionHeader);
  return {
    lines,
    rootEnd: firstSection === -1 ? lines.length : firstSection
  };
}

function parseTomlString(rawValue) {
  const value = rawValue.trim();
  const doubleQuoted = value.match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/u);
  if (doubleQuoted) {
    try {
      return JSON.parse(`"${doubleQuoted[1]}"`);
    } catch {
      return null;
    }
  }
  const singleQuoted = value.match(/^'([^']*)'\s*(?:#.*)?$/u);
  return singleQuoted ? singleQuoted[1] : null;
}

function parseRootAssignments(source) {
  const { lines, rootEnd } = rootLines(source);
  const found = new Map();

  for (let index = 0; index < rootEnd; index += 1) {
    const match = lines[index].match(/^\s*(mcp_oauth_callback_port|mcp_oauth_callback_url)\s*=\s*(.+)$/u);
    if (!match) {
      continue;
    }
    const entries = found.get(match[1]) ?? [];
    entries.push({ index, rawValue: match[2] });
    found.set(match[1], entries);
  }

  return { lines, rootEnd, found };
}

function sectionAssignments(lines, sectionName) {
  const header = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return null;
  }
  const values = new Map();
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isSectionHeader(lines[index])) {
      break;
    }
    const match = lines[index].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/u);
    if (match) {
      values.set(match[1], match[2]);
    }
  }
  return values;
}

function inspectImplantMcpConfig(lines) {
  const serverValues = sectionAssignments(lines, `mcp_servers.${REMOTE_MCP.name}`);
  if (!serverValues) {
    return { present: false, url: null, oauth_client_id: null, conflicts: [] };
  }

  const oauthValues = sectionAssignments(lines, `mcp_servers.${REMOTE_MCP.name}.oauth`);
  const url = serverValues.has("url") ? parseTomlString(serverValues.get("url")) : null;
  const oauthClientId = oauthValues?.has("client_id")
    ? parseTomlString(oauthValues.get("client_id"))
    : null;
  const conflicts = [];
  if (url !== REMOTE_MCP.url) {
    conflicts.push({
      key: `mcp_servers.${REMOTE_MCP.name}.url`,
      reason: "different_value",
      observed: url,
      expected: REMOTE_MCP.url
    });
  }
  if (oauthClientId !== REMOTE_MCP.oauth.clientId) {
    conflicts.push({
      key: `mcp_servers.${REMOTE_MCP.name}.oauth.client_id`,
      reason: oauthClientId === null ? "missing_value" : "different_value",
      observed: oauthClientId,
      expected: REMOTE_MCP.oauth.clientId
    });
  }
  return {
    present: true,
    url,
    oauth_client_id: oauthClientId,
    conflicts
  };
}

function normalizedObservedValue(key, rawValue) {
  if (key === CALLBACK_PORT_KEY) {
    const match = rawValue.trim().match(/^(\d+)\s*(?:#.*)?$/u);
    return match ? Number(match[1]) : null;
  }
  return parseTomlString(rawValue);
}

function inspectSource(source) {
  const parsed = parseRootAssignments(source);
  const observed = {};
  const conflicts = [];
  const missing = [];

  for (const [key, expected] of Object.entries(EXPECTED_VALUES)) {
    const entries = parsed.found.get(key) ?? [];
    if (entries.length === 0) {
      missing.push(key);
      continue;
    }
    if (entries.length !== 1) {
      conflicts.push({ key, reason: "duplicate_root_assignment" });
      continue;
    }
    const value = normalizedObservedValue(key, entries[0].rawValue);
    observed[key] = value;
    if (value !== expected) {
      conflicts.push({ key, reason: "different_value", observed: value, expected });
    }
  }

  const implantMcp = inspectImplantMcpConfig(parsed.lines);
  conflicts.push(...implantMcp.conflicts);

  return { ...parsed, observed, conflicts, missing, implantMcp };
}

function assignmentLine(key) {
  const value = EXPECTED_VALUES[key];
  return typeof value === "number" ? `${key} = ${value}` : `${key} = ${JSON.stringify(value)}`;
}

function insertMissingAssignments(source, missing) {
  if (missing.length === 0) {
    return source;
  }
  const block = [MANAGED_MARKER, ...missing.map(assignmentLine), ""].join("\n");
  return `${block}${source}`;
}

function canonicalOwnership(configPath, insertedKeys) {
  return {
    schema_version: 1,
    owner_package: PACKAGE_NAME,
    resource_type: "codex_oauth_callback_config",
    config_path: configPath,
    inserted_keys: [...insertedKeys],
    expected_values: { ...EXPECTED_VALUES }
  };
}

function ownershipIsCanonical(ownership, configPath) {
  if (
    !ownership
    || ownership.schema_version !== 1
    || ownership.owner_package !== PACKAGE_NAME
    || ownership.resource_type !== "codex_oauth_callback_config"
    || ownership.config_path !== configPath
    || !Array.isArray(ownership.inserted_keys)
  ) {
    return false;
  }
  return ownership.inserted_keys.every((key) => Object.hasOwn(EXPECTED_VALUES, key))
    && Object.entries(EXPECTED_VALUES).every(([key, value]) => ownership.expected_values?.[key] === value);
}

async function readConfig(configPath, fileSystem) {
  try {
    const stat = await fileSystem.lstat(configPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { source: null, mode: null, unsafe: stat.isSymbolicLink() ? "config_symlink" : "config_not_file" };
    }
    return {
      source: await fileSystem.readFile(configPath, "utf8"),
      mode: stat.mode & 0o777,
      unsafe: null
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { source: "", mode: 0o600, unsafe: null };
    }
    throw error;
  }
}

async function assertSafeParent(configPath, fileSystem) {
  const directory = path.dirname(configPath);
  try {
    const stat = await fileSystem.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return stat.isSymbolicLink() ? "codex_home_symlink" : "codex_home_not_directory";
    }
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function atomicWriteText(filePath, source, mode, fileSystem) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  await fileSystem.mkdir(directory, { recursive: true });
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, "wx", mode);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fileSystem.rename(temporaryPath, filePath);
    if (process.platform !== "win32") {
      await fileSystem.chmod(filePath, mode).catch(() => {});
    }
  } finally {
    await handle?.close().catch(() => {});
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function ensureCodexOauthCallbackConfig({
  homeDirectory,
  env = process.env,
  dryRun = false
} = {}, deps = {}) {
  const fileSystem = deps.fs ?? fsp;
  const configPath = configPathFrom(homeDirectory, env);
  const unsafeParent = await assertSafeParent(configPath, fileSystem);
  if (unsafeParent) {
    return {
      ok: false,
      changed: false,
      state: "unsafe_path",
      reason: unsafeParent,
      config_path: configPath
    };
  }

  const current = await readConfig(configPath, fileSystem);
  if (current.unsafe) {
    return {
      ok: false,
      changed: false,
      state: "unsafe_path",
      reason: current.unsafe,
      config_path: configPath
    };
  }

  const inspection = inspectSource(current.source);
  if (inspection.conflicts.length > 0) {
    return {
      ok: false,
      changed: false,
      state: "conflict",
      config_path: configPath,
      conflicts: inspection.conflicts,
      expected_values: { ...EXPECTED_VALUES }
    };
  }

  const changed = inspection.missing.length > 0;
  if (changed && !dryRun) {
    await atomicWriteText(
      configPath,
      insertMissingAssignments(current.source, inspection.missing),
      current.mode ?? 0o600,
      fileSystem
    );
  }

  return {
    ok: true,
    changed,
    state: changed ? (dryRun ? "would_configure" : "configured") : "ready",
    config_path: configPath,
    callback_port: REMOTE_MCP.oauth.codex.callbackPort,
    callback_url: REMOTE_MCP.oauth.codex.callbackUrl,
    redirect_uri: REMOTE_MCP.oauth.codex.redirectUri,
    implant_mcp: inspection.implantMcp,
    ownership: changed ? canonicalOwnership(configPath, inspection.missing) : null
  };
}

function removeOwnedAssignments(source, insertedKeys) {
  const keys = new Set(insertedKeys);
  const { lines, rootEnd } = rootLines(source);
  const retained = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index < rootEnd) {
      const match = line.match(/^\s*(mcp_oauth_callback_port|mcp_oauth_callback_url)\s*=\s*(.+)$/u);
      if (match && keys.has(match[1])) {
        continue;
      }
      if (line === MANAGED_MARKER) {
        continue;
      }
    }
    retained.push(line);
  }

  while (retained.length > 1 && retained[0] === "" && retained[1] === "") {
    retained.shift();
  }
  return retained.join("\n");
}

export async function removeOwnedCodexOauthCallbackConfig({
  homeDirectory,
  env = process.env,
  ownership,
  dryRun = false
} = {}, deps = {}) {
  const fileSystem = deps.fs ?? fsp;
  const configPath = configPathFrom(homeDirectory, env);
  if (!ownershipIsCanonical(ownership, configPath)) {
    return {
      safe: false,
      changed: false,
      state: "preserved_unproven",
      config_path: configPath
    };
  }

  const current = await readConfig(configPath, fileSystem);
  if (current.unsafe) {
    return {
      safe: false,
      changed: false,
      state: "preserved_unsafe_path",
      reason: current.unsafe,
      config_path: configPath
    };
  }

  const inspection = inspectSource(current.source);
  const ownedKeys = ownership.inserted_keys;
  const changedOwnedValue = ownedKeys.find((key) => inspection.observed[key] !== EXPECTED_VALUES[key]);
  if (changedOwnedValue) {
    return {
      safe: false,
      changed: false,
      state: "preserved_modified",
      key: changedOwnedValue,
      config_path: configPath
    };
  }

  if (ownedKeys.length === 0) {
    return { safe: true, changed: false, state: "nothing_owned", config_path: configPath };
  }

  if (!dryRun) {
    await atomicWriteText(
      configPath,
      removeOwnedAssignments(current.source, ownedKeys),
      current.mode ?? 0o600,
      fileSystem
    );
  }
  return {
    safe: true,
    changed: true,
    state: dryRun ? "would_remove" : "removed",
    config_path: configPath,
    removed_keys: [...ownedKeys]
  };
}

export const CODEX_OAUTH_CONFIG = Object.freeze({
  marker: MANAGED_MARKER,
  expectedValues: EXPECTED_VALUES
});
