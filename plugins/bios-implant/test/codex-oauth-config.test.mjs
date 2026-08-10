import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_OAUTH_CONFIG,
  ensureCodexOauthCallbackConfig,
  removeOwnedCodexOauthCallbackConfig
} from "../src/codex-oauth-config.mjs";
import { REMOTE_MCP } from "../src/constants.mjs";

async function makeHome(t) {
  const homeDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "bios-codex-oauth-"));
  t.after(() => fsp.rm(homeDirectory, { recursive: true, force: true }));
  return homeDirectory;
}

test("Codex callback id and registered redirect stay bound to the canonical MCP URL", () => {
  const url = new URL(REMOTE_MCP.url);
  url.hash = "";
  const callbackId = crypto
    .createHash("sha256")
    .update(url.toString())
    .digest()
    .subarray(0, 9)
    .toString("base64url");

  assert.equal(callbackId, REMOTE_MCP.oauth.codex.callbackId);
  assert.equal(
    REMOTE_MCP.oauth.codex.redirectUri,
    `${REMOTE_MCP.oauth.codex.callbackUrl}/${callbackId}`
  );
});

test("installer adds fixed Codex MCP OAuth callback settings and is idempotent", async (t) => {
  const homeDirectory = await makeHome(t);
  const configPath = path.join(homeDirectory, ".codex", "config.toml");
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, 'model = "gpt-5.6"\n\n[mcp_servers.other]\nurl = "https://example.test/mcp"\n', "utf8");

  const first = await ensureCodexOauthCallbackConfig({ homeDirectory, env: {} });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.deepEqual(first.ownership.inserted_keys.sort(), [
    "mcp_oauth_callback_port",
    "mcp_oauth_callback_url"
  ]);

  const source = await fsp.readFile(configPath, "utf8");
  assert.match(source, /mcp_oauth_callback_port = 8486/u);
  assert.match(source, /mcp_oauth_callback_url = "http:\/\/127\.0\.0\.1:8486\/callback"/u);
  assert.match(source, /\[mcp_servers\.other\]/u);

  const second = await ensureCodexOauthCallbackConfig({ homeDirectory, env: {} });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(await fsp.readFile(configPath, "utf8"), source);
});

test("installer preserves conflicting callback settings", async (t) => {
  const homeDirectory = await makeHome(t);
  const configPath = path.join(homeDirectory, ".codex", "config.toml");
  const original = 'mcp_oauth_callback_port = 9000\nmodel = "gpt-5.6"\n';
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, original, "utf8");

  const result = await ensureCodexOauthCallbackConfig({ homeDirectory, env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.state, "conflict");
  assert.equal(result.conflicts[0].key, "mcp_oauth_callback_port");
  assert.equal(await fsp.readFile(configPath, "utf8"), original);
});

test("installer preserves an existing same-name MCP with a different or missing static client", async (t) => {
  const homeDirectory = await makeHome(t);
  const configPath = path.join(homeDirectory, ".codex", "config.toml");
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(
    configPath,
    `[mcp_servers.implant]\nurl = "${REMOTE_MCP.url}"\n\n[mcp_servers.implant.oauth]\nclient_id = "another-client"\n`,
    "utf8"
  );

  const different = await ensureCodexOauthCallbackConfig({ homeDirectory, env: {} });
  assert.equal(different.ok, false);
  assert.ok(different.conflicts.some((entry) =>
    entry.key === "mcp_servers.implant.oauth.client_id" && entry.reason === "different_value"
  ));

  await fsp.writeFile(
    configPath,
    `[mcp_servers.implant]\nurl = "${REMOTE_MCP.url}"\n`,
    "utf8"
  );
  const missing = await ensureCodexOauthCallbackConfig({ homeDirectory, env: {} });
  assert.equal(missing.ok, false);
  assert.ok(missing.conflicts.some((entry) =>
    entry.key === "mcp_servers.implant.oauth.client_id" && entry.reason === "missing_value"
  ));
});

test("uninstall removes only exact installer-owned callback settings", async (t) => {
  const homeDirectory = await makeHome(t);
  const configPath = path.join(homeDirectory, ".codex", "config.toml");
  const installed = await ensureCodexOauthCallbackConfig({ homeDirectory, env: {} });
  await fsp.appendFile(configPath, 'model = "gpt-5.6"\n', "utf8");

  const removed = await removeOwnedCodexOauthCallbackConfig({
    homeDirectory,
    env: {},
    ownership: installed.ownership
  });
  assert.equal(removed.safe, true);
  assert.equal(removed.state, "removed");

  const source = await fsp.readFile(configPath, "utf8");
  assert.doesNotMatch(source, /mcp_oauth_callback_/u);
  assert.doesNotMatch(source, new RegExp(CODEX_OAUTH_CONFIG.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.match(source, /model = "gpt-5\.6"/u);
});

test("uninstall preserves callback config after an owned value is changed", async (t) => {
  const homeDirectory = await makeHome(t);
  const configPath = path.join(homeDirectory, ".codex", "config.toml");
  const installed = await ensureCodexOauthCallbackConfig({ homeDirectory, env: {} });
  const changed = (await fsp.readFile(configPath, "utf8")).replace(
    "mcp_oauth_callback_port = 8486",
    "mcp_oauth_callback_port = 9000"
  );
  await fsp.writeFile(configPath, changed, "utf8");

  const result = await removeOwnedCodexOauthCallbackConfig({
    homeDirectory,
    env: {},
    ownership: installed.ownership
  });
  assert.equal(result.safe, false);
  assert.equal(result.state, "preserved_modified");
  assert.equal(await fsp.readFile(configPath, "utf8"), changed);
});
