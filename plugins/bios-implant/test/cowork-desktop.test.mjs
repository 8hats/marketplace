import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectCoworkInstallation,
  resolveCoworkProfile
} from "../src/cowork-desktop.mjs";
import { doctorHarness, resolveHarnesses } from "../src/harnesses.mjs";

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value), "utf8");
}

test("Cowork profile resolution follows the active Desktop account and organization from Claude logs", async (t) => {
  const homeDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-cowork-profile-log-"));
  t.after(() => fsp.rm(homeDirectory, { recursive: true, force: true }));
  const desktopRoot = path.join(homeDirectory, "Library", "Application Support", "Claude");
  const profileRoot = path.join(
    desktopRoot,
    "local-agent-mode-sessions",
    "account-active",
    "organization-active"
  );
  await writeJson(path.join(desktopRoot, "cowork-enabled-cli-ops.json"), {
    ownerAccountId: "account-active"
  });
  await writeJson(path.join(profileRoot, "rpm", "manifest.json"), { plugins: [] });
  const logPath = path.join(homeDirectory, "Library", "Logs", "Claude", "main.log");
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await fsp.writeFile(
    logPath,
    "2026-08-04 19:28:59 [info] [LocalAgentModeSessionManager] Initialization succeeded — accountId=account-active, orgId=organization-active, existingSessions=0\n",
    "utf8"
  );

  const result = await resolveCoworkProfile({ homeDirectory, platform: "darwin" });

  assert.equal(result.ok, true);
  assert.equal(result.account_id, "account-active");
  assert.equal(result.organization_id, "organization-active");
  assert.equal(result.config_dir, profileRoot);
  assert.equal(result.source, "claude_desktop_log");
});

test("Cowork profile resolution falls back to the latest active organization for the Desktop owner", async (t) => {
  const homeDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-cowork-profile-fallback-"));
  t.after(() => fsp.rm(homeDirectory, { recursive: true, force: true }));
  const desktopRoot = path.join(homeDirectory, "Library", "Application Support", "Claude");
  const sessionsRoot = path.join(desktopRoot, "local-agent-mode-sessions");
  const olderManifest = path.join(sessionsRoot, "account-owner", "organization-old", "rpm", "manifest.json");
  const newerManifest = path.join(sessionsRoot, "account-owner", "organization-new", "rpm", "manifest.json");
  await writeJson(path.join(desktopRoot, "cowork-enabled-cli-ops.json"), {
    ownerAccountId: "account-owner"
  });
  await writeJson(olderManifest, { plugins: [] });
  await writeJson(newerManifest, { plugins: [] });
  await fsp.utimes(olderManifest, new Date("2026-08-04T10:00:00Z"), new Date("2026-08-04T10:00:00Z"));
  await fsp.utimes(newerManifest, new Date("2026-08-04T11:00:00Z"), new Date("2026-08-04T11:00:00Z"));

  const result = await resolveCoworkProfile({ homeDirectory, platform: "darwin" });

  assert.equal(result.ok, true);
  assert.equal(result.account_id, "account-owner");
  assert.equal(result.organization_id, "organization-new");
  assert.equal(result.source, "desktop_owner_latest_activity");
});

test("Cowork inspection observes both remote registry and local plugin manifests", async (t) => {
  const homeDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-cowork-inspection-"));
  t.after(() => fsp.rm(homeDirectory, { recursive: true, force: true }));
  const organizationRoot = path.join(
    homeDirectory,
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions",
    "account-id",
    "organization-id"
  );
  await writeJson(path.join(organizationRoot, "rpm", "manifest.json"), {
    plugins: [{
      id: "plugin_bios",
      name: "bios-implant",
      displayName: "BIOS Implant",
      marketplaceName: "agent-university",
      installedBy: "user"
    }]
  });
  await writeJson(path.join(
    organizationRoot,
    "cowork_plugins",
    "cache",
    "bios-implant",
    ".claude-plugin",
    "plugin.json"
  ), {
    name: "bios-implant",
    displayName: "BIOS Implant",
    version: "1.0.11"
  });

  const result = await inspectCoworkInstallation({ homeDirectory, platform: "darwin" });
  assert.equal(result.installed, true);
  assert.equal(result.state, "COWORK_PLUGIN_OBSERVED");
  assert.equal(result.observations.length, 2);
  assert.ok(result.observations.some((entry) => entry.version === "1.0.11"));
});

test("Cowork doctor never substitutes Claude Code registration for Desktop state", async () => {
  const result = await doctorHarness({
    harness: "cowork",
    detection: {
      harness: "cowork",
      detected: true,
      supported: true,
      app_present: true,
      executable: "/usr/local/bin/claude",
      version: "2.1.220"
    }
  }, {
    inspectCoworkInstallation: async () => ({
      installed: false,
      state: "COWORK_PLUGIN_NOT_OBSERVED",
      observations: [],
      inspected_paths: []
    })
  });

  assert.equal(result.result, "WARN");
  assert.equal(result.code, "COWORK_PLUGIN_NOT_OBSERVED");
  assert.equal(result.checks.some((check) => check.code === "CLAUDE_PLUGIN_PRESENT"), false);
});

test("all expands to all three distinct harnesses", () => {
  assert.deepEqual(resolveHarnesses(["all"]), ["cowork", "claude", "codex"]);
});
