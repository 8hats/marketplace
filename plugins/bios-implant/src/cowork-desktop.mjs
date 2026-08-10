import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PLUGIN_NAME } from "./constants.mjs";
export const COWORK_PLUGIN_OBSERVED = "COWORK_PLUGIN_OBSERVED";
export const COWORK_PLUGIN_NOT_OBSERVED = "COWORK_PLUGIN_NOT_OBSERVED";

const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_LOG_TAIL_BYTES = 2 * 1024 * 1024;

function desktopSupportRoot(homeDirectory, platform, env) {
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Claude");
  }
  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(homeDirectory, "AppData", "Roaming"), "Claude");
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(homeDirectory, ".config"), "Claude");
}

function desktopStateRoot(homeDirectory, platform, env) {
  return path.join(desktopSupportRoot(homeDirectory, platform, env), "local-agent-mode-sessions");
}

function desktopLogCandidates(homeDirectory, platform, env) {
  if (platform === "darwin") {
    return [path.join(homeDirectory, "Library", "Logs", "Claude", "main.log")];
  }
  const supportRoot = desktopSupportRoot(homeDirectory, platform, env);
  return [
    path.join(supportRoot, "logs", "main.log"),
    path.join(supportRoot, "main.log")
  ];
}

function validProfileId(value) {
  return typeof value === "string" && PROFILE_ID_PATTERN.test(value);
}

async function isDirectory(directoryPath, fileSystem) {
  try {
    return (await fileSystem.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function readLogTail(filePath, fileSystem) {
  let handle;
  try {
    const stat = await fileSystem.stat(filePath);
    const length = Math.min(stat.size, MAX_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    handle = await fileSystem.open(filePath, "r");
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function activeProfileFromLog(text) {
  if (!text) {
    return null;
  }
  const pattern = /\[Local(?:AgentMode)?SessionManager\] Initialization succeeded[^\n]*accountId=([^,\s]+),\s*orgId=([^,\s]+)/gu;
  let latest = null;
  for (const match of text.matchAll(pattern)) {
    if (validProfileId(match[1]) && validProfileId(match[2])) {
      latest = { account_id: match[1], organization_id: match[2] };
    }
  }
  return latest;
}

async function profileActivity(profileRoot, fileSystem) {
  const candidates = [
    path.join(profileRoot, "rpm", "manifest.json"),
    path.join(profileRoot, "cowork_plugins", "installed_plugins.json"),
    path.join(profileRoot, "cowork_settings.json"),
    profileRoot
  ];
  let latest = 0;
  for (const candidate of candidates) {
    try {
      latest = Math.max(latest, (await fileSystem.stat(candidate)).mtimeMs || 0);
    } catch {
      // Missing optional activity signal.
    }
  }
  return latest;
}

async function profileCandidates(stateRoot, accountIds, fileSystem) {
  const profiles = [];
  for (const accountId of accountIds) {
    if (!validProfileId(accountId)) {
      continue;
    }
    const accountRoot = path.join(stateRoot, accountId);
    for (const entry of await directoryEntries(accountRoot, fileSystem)) {
      if (!entry.isDirectory() || !validProfileId(entry.name)) {
        continue;
      }
      const configDir = path.join(accountRoot, entry.name);
      profiles.push({
        account_id: accountId,
        organization_id: entry.name,
        config_dir: configDir,
        activity_ms: await profileActivity(configDir, fileSystem)
      });
    }
  }
  return profiles.sort((left, right) => right.activity_ms - left.activity_ms);
}

export async function resolveCoworkProfile({
  homeDirectory = os.homedir(),
  platform = process.platform,
  env = process.env,
  fileSystem = fsp
} = {}) {
  const supportRoot = desktopSupportRoot(homeDirectory, platform, env);
  const stateRoot = desktopStateRoot(homeDirectory, platform, env);
  const owner = await readJson(path.join(supportRoot, "cowork-enabled-cli-ops.json"), fileSystem);
  const ownerAccountId = validProfileId(owner?.ownerAccountId) ? owner.ownerAccountId : null;

  for (const logPath of desktopLogCandidates(homeDirectory, platform, env)) {
    const active = activeProfileFromLog(await readLogTail(logPath, fileSystem));
    if (!active || (ownerAccountId && active.account_id !== ownerAccountId)) {
      continue;
    }
    const configDir = path.join(stateRoot, active.account_id, active.organization_id);
    if (await isDirectory(configDir, fileSystem)) {
      return {
        ok: true,
        ...active,
        config_dir: configDir,
        state_root: stateRoot,
        source: "claude_desktop_log"
      };
    }
  }

  let accountIds = ownerAccountId ? [ownerAccountId] : [];
  if (accountIds.length === 0) {
    accountIds = (await directoryEntries(stateRoot, fileSystem))
      .filter((entry) => entry.isDirectory() && entry.name !== "skills-plugin")
      .map((entry) => entry.name);
  }
  const candidates = await profileCandidates(stateRoot, accountIds, fileSystem);
  if (candidates.length > 0) {
    const selected = candidates[0];
    return {
      ok: true,
      account_id: selected.account_id,
      organization_id: selected.organization_id,
      config_dir: selected.config_dir,
      state_root: stateRoot,
      source: ownerAccountId ? "desktop_owner_latest_activity" : "desktop_latest_activity"
    };
  }

  return {
    ok: false,
    code: "COWORK_PROFILE_NOT_FOUND",
    message: "No active Claude Desktop Cowork profile was found. Open Local Cowork once, then rerun installation.",
    state_root: stateRoot,
    source: "none"
  };
}

async function directoryEntries(directoryPath, fileSystem) {
  try {
    return await fileSystem.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code)) {
      return [];
    }
    throw error;
  }
}

async function readJson(filePath, fileSystem) {
  try {
    return JSON.parse(await fileSystem.readFile(filePath, "utf8"));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "INVALID_JSON"].includes(error?.code)) {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isBiosPlugin(value) {
  const name = String(value?.name ?? "").trim().toLowerCase();
  const displayName = String(value?.displayName ?? "").trim().toLowerCase();
  return name === PLUGIN_NAME || displayName === "bios implant";
}

async function inspectRpmManifest(manifestPath, fileSystem) {
  const manifest = await readJson(manifestPath, fileSystem);
  return (manifest?.plugins ?? [])
    .filter(isBiosPlugin)
    .map((plugin) => ({
      source: "cowork_rpm_manifest",
      path: manifestPath,
      plugin_id: plugin.id ?? null,
      name: plugin.name ?? null,
      display_name: plugin.displayName ?? null,
      marketplace_name: plugin.marketplaceName ?? null,
      installed_by: plugin.installedBy ?? null,
      updated_at: plugin.updatedAt ?? null
    }));
}

async function inspectPluginTree(rootPath, fileSystem, maxDepth = 6, budget = { remaining: 5000 }) {
  const observations = [];

  async function walk(currentPath, depth) {
    if (depth > maxDepth || budget.remaining <= 0) {
      return;
    }
    const entries = await directoryEntries(currentPath, fileSystem);
    for (const entry of entries) {
      if (budget.remaining <= 0) {
        break;
      }
      budget.remaining -= 1;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name !== "plugin.json" || path.basename(path.dirname(entryPath)) !== ".claude-plugin") {
        continue;
      }
      const plugin = await readJson(entryPath, fileSystem);
      if (isBiosPlugin(plugin)) {
        observations.push({
          source: "cowork_plugin_manifest",
          path: entryPath,
          name: plugin.name ?? null,
          display_name: plugin.displayName ?? null,
          version: plugin.version ?? null
        });
      }
    }
  }

  await walk(rootPath, 0);
  return observations;
}

export async function inspectCoworkInstallation({
  homeDirectory = os.homedir(),
  platform = process.platform,
  env = process.env,
  fileSystem = fsp
} = {}) {
  const stateRoot = desktopStateRoot(homeDirectory, platform, env);
  const accountEntries = await directoryEntries(stateRoot, fileSystem);
  const observations = [];
  const inspectedPaths = [];

  for (const accountEntry of accountEntries) {
    if (!accountEntry.isDirectory() || accountEntry.name === "skills-plugin") {
      continue;
    }
    const accountPath = path.join(stateRoot, accountEntry.name);
    const organizationEntries = await directoryEntries(accountPath, fileSystem);
    for (const organizationEntry of organizationEntries) {
      if (!organizationEntry.isDirectory()) {
        continue;
      }
      const organizationPath = path.join(accountPath, organizationEntry.name);
      const rpmManifestPath = path.join(organizationPath, "rpm", "manifest.json");
      inspectedPaths.push(rpmManifestPath);
      observations.push(...await inspectRpmManifest(rpmManifestPath, fileSystem));

      for (const pluginDirectoryName of ["cowork_plugins", "remote_cowork_plugins"]) {
        const pluginRoot = path.join(organizationPath, pluginDirectoryName);
        inspectedPaths.push(pluginRoot);
        observations.push(...await inspectPluginTree(pluginRoot, fileSystem));
      }
    }
  }

  const uniqueObservations = [...new Map(
    observations.map((observation) => [`${observation.source}:${observation.path}`, observation])
  ).values()];

  return {
    state_root: stateRoot,
    desktop_state_available: accountEntries.length > 0,
    installed: uniqueObservations.length > 0,
    state: uniqueObservations.length > 0 ? COWORK_PLUGIN_OBSERVED : COWORK_PLUGIN_NOT_OBSERVED,
    observations: uniqueObservations,
    inspected_paths: inspectedPaths
  };
}
