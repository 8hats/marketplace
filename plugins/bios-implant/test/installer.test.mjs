import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FAILURE_MARKETPLACE_CONFLICT,
  detectHarnesses,
  doctorHarness,
  installHarness,
  selectRequestedHarnesses,
  uninstallHarness
} from "../src/harnesses.mjs";
import {
  materializeCatalog,
  resolveInstallerStateRoot,
  runInstaller
} from "../src/installer.mjs";
import { PACKAGE_NAME, PACKAGE_VERSION, PLUGIN_ID, REMOTE_MCP } from "../src/constants.mjs";

const PACKAGE_ROOT = path.resolve(".");

async function makeSandbox(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function makeExecutable(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, "fixture executable\n", "utf8");
  if (process.platform !== "win32") {
    await fsp.chmod(filePath, 0o700);
  }
  return filePath;
}

function codexMcpOwnership() {
  return {
    schema_version: 1,
    owner_package: PACKAGE_NAME,
    harness: "codex",
    resource_type: "mcp_server",
    name: REMOTE_MCP.name,
    url: REMOTE_MCP.url,
    oauth_client_id: REMOTE_MCP.oauth.clientId
  };
}

function commandResult(command, args, value, exitCode = 0) {
  return {
    command,
    args: [...args],
    exitCode,
    signal: null,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: ""
  };
}

function claudePluginEntry() {
  return {
    id: PLUGIN_ID,
    version: PACKAGE_VERSION,
    scope: "user",
    enabled: true,
    mcpServers: {
      implant: { type: "http", url: REMOTE_MCP.url },
      "implant-local": { type: "stdio", command: "node" }
    }
  };
}

function codexPluginEntry() {
  return {
    pluginId: PLUGIN_ID,
    name: "bios-implant",
    marketplaceName: "agent-university",
    version: PACKAGE_VERSION,
    installed: true,
    enabled: true,
    source: {
      source: "npm",
      package: PACKAGE_NAME,
      version: "latest"
    }
  };
}

test("installer state root uses explicit override, Agent University home, then HOME", () => {
  assert.equal(
    resolveInstallerStateRoot({}, { env: {
      BIOS_IMPLANT_STATE_ROOT: "/tmp/bios-explicit",
      AGENT_UNIVERSITY_HOME: "/tmp/au-home",
      HOME: "/tmp/home"
    } }),
    path.resolve("/tmp/bios-explicit")
  );
  assert.equal(
    resolveInstallerStateRoot({}, { env: {
      AGENT_UNIVERSITY_HOME: "/tmp/au-home",
      HOME: "/tmp/home"
    } }),
    path.resolve("/tmp/au-home")
  );
  assert.equal(
    resolveInstallerStateRoot({}, { env: { HOME: "/tmp/home" } }),
    path.resolve("/tmp/home/.agent-university")
  );
});

test("catalog materialization is content-compared and idempotent", async (t) => {
  const stateRoot = await makeSandbox(t, "bios-catalog-");
  const env = { BIOS_IMPLANT_STATE_ROOT: stateRoot, HOME: path.dirname(stateRoot) };

  const first = await materializeCatalog({}, { packageRoot: PACKAGE_ROOT, env });
  const second = await materializeCatalog({}, { packageRoot: PACKAGE_ROOT, env });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  const marketplace = JSON.parse(await fsp.readFile(
    path.join(stateRoot, "bios-implant", "catalog", ".claude-plugin", "marketplace.json"),
    "utf8"
  ));
  assert.deepEqual(marketplace.owner, { name: "Agent University" });
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "npm",
    package: PACKAGE_NAME
  });
});

test("install rejects a symlinked state root without writing through it", async (t) => {
  const sandbox = await makeSandbox(t, "bios-state-root-symlink-");
  const outsideRoot = path.join(sandbox, "outside");
  const stateRoot = path.join(sandbox, "state");
  await fsp.mkdir(outsideRoot, { recursive: true });
  await fsp.writeFile(path.join(outsideRoot, "sentinel.txt"), "preserve\n", "utf8");
  await fsp.symlink(outsideRoot, stateRoot, "dir");

  const result = await runInstaller("install", { yes: true, harnesses: ["codex"] }, {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: { BIOS_IMPLANT_STATE_ROOT: stateRoot, HOME: sandbox, PATH: path.join(sandbox, "empty") },
    resolveExecutable: () => null
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.warnings[0].code, "UNSAFE_STATE_PATH");
  assert.equal(result.warnings[0].details.reason, "state_root_symlink");
  assert.equal(await fsp.readFile(path.join(outsideRoot, "sentinel.txt"), "utf8"), "preserve\n");
  await assert.rejects(fsp.access(path.join(outsideRoot, "bios-implant")), { code: "ENOENT" });
});

test("install rejects a missing state root beneath a symlinked ancestor", async (t) => {
  const sandbox = await makeSandbox(t, "bios-state-ancestor-symlink-");
  const outsideRoot = path.join(sandbox, "outside");
  const linkedParent = path.join(sandbox, "linked-parent");
  const stateRoot = path.join(linkedParent, "state");
  await fsp.mkdir(outsideRoot, { recursive: true });
  await fsp.writeFile(path.join(outsideRoot, "sentinel.txt"), "preserve\n", "utf8");
  await fsp.symlink(outsideRoot, linkedParent, "dir");

  const result = await runInstaller("install", { yes: true, harnesses: ["codex"] }, {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: { BIOS_IMPLANT_STATE_ROOT: stateRoot, HOME: sandbox, PATH: path.join(sandbox, "empty") },
    resolveExecutable: () => null
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.warnings[0].code, "UNSAFE_STATE_PATH");
  assert.equal(result.warnings[0].details.reason, "state_root_ancestor_symlink");
  assert.equal(await fsp.readFile(path.join(outsideRoot, "sentinel.txt"), "utf8"), "preserve\n");
  await assert.rejects(fsp.access(path.join(outsideRoot, "state")), { code: "ENOENT" });
});

test("install rejects a symlinked install home without writing through it", async (t) => {
  const sandbox = await makeSandbox(t, "bios-install-home-symlink-");
  const outsideInstallHome = path.join(sandbox, "outside-install-home");
  const stateRoot = path.join(sandbox, "state");
  const installHome = path.join(stateRoot, "bios-implant");
  await fsp.mkdir(outsideInstallHome, { recursive: true });
  await fsp.writeFile(path.join(outsideInstallHome, "sentinel.txt"), "preserve\n", "utf8");
  await fsp.mkdir(stateRoot, { recursive: true });
  await fsp.symlink(outsideInstallHome, installHome, "dir");

  const result = await runInstaller("install", { yes: true, harnesses: ["codex"] }, {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: { BIOS_IMPLANT_STATE_ROOT: stateRoot, HOME: sandbox, PATH: path.join(sandbox, "empty") },
    resolveExecutable: () => null
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.warnings[0].code, "UNSAFE_STATE_PATH");
  assert.equal(result.warnings[0].details.reason, "symlink_traversal");
  assert.equal(await fsp.readFile(path.join(outsideInstallHome, "sentinel.txt"), "utf8"), "preserve\n");
  await assert.rejects(fsp.access(path.join(outsideInstallHome, "catalog")), { code: "ENOENT" });
  await assert.rejects(fsp.access(path.join(outsideInstallHome, "install-state.json")), { code: "ENOENT" });
});

test("install and uninstall reject a symlinked install-state file", async (t) => {
  const sandbox = await makeSandbox(t, "bios-install-state-symlink-");
  const stateRoot = path.join(sandbox, "state");
  const installHome = path.join(stateRoot, "bios-implant");
  const outsideState = path.join(sandbox, "outside-state.json");
  const outsideContents = `${JSON.stringify({ package_name: PACKAGE_NAME, ownership: {} })}\n`;
  await fsp.mkdir(installHome, { recursive: true });
  await fsp.writeFile(outsideState, outsideContents, "utf8");
  await fsp.symlink(outsideState, path.join(installHome, "install-state.json"), "file");

  for (const command of ["install", "uninstall"]) {
    const result = await runInstaller(command, { yes: true, harnesses: ["codex"] }, {
      packageRoot: PACKAGE_ROOT,
      platform: "linux",
      env: { BIOS_IMPLANT_STATE_ROOT: stateRoot, HOME: sandbox, PATH: path.join(sandbox, "empty") },
      resolveExecutable: () => null
    });
    assert.equal(result.status, "FAIL");
    assert.equal(result.warnings[0].code, "UNSAFE_STATE_PATH");
    assert.equal(result.warnings[0].details.reason, "symlink_traversal");
  }

  assert.equal(await fsp.readFile(outsideState, "utf8"), outsideContents);
});

test("Claude reconciliation is a no-op when marketplace and plugin are current", async () => {
  const catalogPath = path.resolve("/tmp/agent-university/catalog");
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    if (args.join(" ") === "plugin marketplace list --json") {
      return commandResult(command, args, [{
        name: "agent-university",
        source: "directory",
        path: catalogPath,
        installLocation: catalogPath
      }]);
    }
    if (args.join(" ") === "plugin list --json") {
      return commandResult(command, args, [claudePluginEntry()]);
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  const result = await installHarness({
    harness: "claude",
    detection: {
      harness: "claude",
      detected: true,
      supported: true,
      executable: "claude",
      version: "2.1.0",
      app_present: true
    },
    catalogPath
  }, { runCommand, options: { timeoutSeconds: 5 } });

  assert.equal(result.result, "WARN");
  assert.equal(result.changed, false);
  assert.ok(result.warnings.some((warning) => warning.code === "RUNTIME_PROBE_REQUIRED"));
  assert.equal(calls.some((call) => call.includes("add")), false);
  assert.equal(calls.some((call) => call.includes("install")), false);
  assert.equal(calls.some((call) => call.includes("update")), false);
});

test("auto targets Local Cowork only when Claude Desktop is present", () => {
  const claude = {
    harness: "claude",
    detected: true,
    supported: true,
    executable: "claude",
    version: "2.1.0",
    app_present: true
  };
  const codex = {
    harness: "codex",
    detected: true,
    supported: true,
    executable: "codex",
    version: "1.2.0"
  };
  const detectionResult = {
    detections: [claude, codex],
    byHarness: {
      claude,
      cowork: { ...claude, harness: "cowork", cowork_ready: true },
      codex
    }
  };

  assert.deepEqual(selectRequestedHarnesses(["auto"], detectionResult), ["cowork"]);
});

test("Local Cowork installs through Claude CLI cowork mode and verifies native registration", async () => {
  const calls = [];
  let marketplaceAdded = false;
  let pluginInstalled = false;
  const profileRoot = "/tmp/claude-desktop/account-id/organization-id";
  const npmCachePath = "/tmp/bios-implant/npm-cache";
  const catalogPath = "/tmp/bios-implant/catalog";
  const runCommand = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(command, "/usr/local/bin/claude");
    assert.equal(args.includes("--cowork"), true);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, profileRoot);
    assert.equal(options.env.NPM_CONFIG_CACHE, npmCachePath);

    if (args.includes("marketplace") && args.includes("list")) {
      return commandResult(command, args, marketplaceAdded ? [{
        name: "agent-university",
        source: "directory",
        path: catalogPath,
        installLocation: catalogPath
      }] : []);
    }
    if (args.includes("marketplace") && args.includes("add")) {
      marketplaceAdded = true;
      return commandResult(command, args, "Marketplace added");
    }
    if (args.includes("plugin") && args.includes("list")) {
      return commandResult(command, args, pluginInstalled ? [claudePluginEntry()] : []);
    }
    if (args.includes("plugin") && args.includes("install")) {
      pluginInstalled = true;
      return commandResult(command, args, "Plugin installed");
    }
    assert.fail(`Unexpected Cowork command: ${args.join(" ")}`);
  };

  const result = await installHarness({
    harness: "cowork",
    detection: {
      harness: "cowork",
      detected: true,
      supported: true,
      app_present: true,
      executable: "/usr/local/bin/claude",
      version: "2.1.220"
    },
    catalogPath,
    coworkProfile: {
      ok: true,
      account_id: "account-id",
      organization_id: "organization-id",
      config_dir: profileRoot,
      source: "claude_desktop_log"
    },
    npmCachePath
  }, {
    env: { PATH: "/usr/local/bin" },
    runCommand,
    options: { timeoutSeconds: 5 }
  });

  assert.equal(result.result, "WARN");
  assert.equal(result.code, "OK");
  assert.equal(result.changed, true);
  assert.equal(result.details.registration_state, "installed_and_verified");
  assert.equal(result.details.cowork_profile.organization_id, "organization-id");
  assert.equal(result.warnings.some((warning) => warning.code === "COWORK_CONFIRMATION_REQUIRED"), false);
  assert.equal(calls.some((call) => call.command === "open"), false);
  assert.ok(calls.some((call) => call.args.includes("install")));
});

test("same-name marketplace at another path fails closed", async () => {
  const runCommand = async (command, args) => commandResult(command, args, [{
    name: "agent-university",
    source: "directory",
    path: "/tmp/foreign-catalog",
    installLocation: "/tmp/foreign-catalog"
  }]);

  const result = await installHarness({
    harness: "claude",
    detection: {
      harness: "claude",
      detected: true,
      supported: true,
      executable: "claude",
      version: "2.1.0"
    },
    catalogPath: "/tmp/owned-catalog"
  }, { runCommand });

  assert.equal(result.result, "FAIL");
  assert.equal(result.code, FAILURE_MARKETPLACE_CONFLICT);
});

test("Codex preserves an unknown same-name implant MCP conflict", async () => {
  const catalogPath = path.resolve("/tmp/agent-university/codex-catalog");
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, {
        marketplaces: [{ name: "agent-university", root: catalogPath }]
      });
    }
    if (joined === "plugin list --json") {
      return commandResult(command, args, { installed: [codexPluginEntry()], available: [] });
    }
    if (joined === "mcp get implant --json") {
      return commandResult(command, args, {
        name: "implant",
        url: "https://wrong.example/mcp",
        oauth_client_id: REMOTE_MCP.oauth.clientId
      });
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  const result = await installHarness({
    harness: "codex",
    detection: {
      harness: "codex",
      detected: true,
      supported: true,
      executable: "codex",
      version: "1.2.0"
    },
    catalogPath
  }, { runCommand, options: { timeoutSeconds: 5 } });

  assert.equal(result.result, "FAIL");
  assert.equal(result.changed, false);
  assert.equal(result.details.mcp_conflict.preserved, true);
  assert.equal(calls.some((call) => call.includes("remove") || call.includes("add")), false);
  assert.equal(result.commands.some((entry) => entry.args[1] === "add"), false);
});

test("Codex adds URL and client only, succeeds with AUTH_REQUIRED, and emits ownership evidence", async () => {
  const catalogPath = path.resolve("/tmp/agent-university/codex-owned-catalog");
  const calls = [];
  let mcpPresent = false;
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, {
        marketplaces: [{ name: "agent-university", root: catalogPath }]
      });
    }
    if (joined === "plugin list --json") {
      return commandResult(command, args, { installed: [codexPluginEntry()] });
    }
    if (joined === "mcp get implant --json") {
      return mcpPresent
        ? commandResult(command, args, {
            name: REMOTE_MCP.name,
            url: REMOTE_MCP.url,
            oauth_client_id: REMOTE_MCP.oauth.clientId
          })
        : commandResult(command, args, "implant not found", 1);
    }
    if (joined === `mcp add implant --url ${REMOTE_MCP.url} --oauth-client-id ${REMOTE_MCP.oauth.clientId}`) {
      mcpPresent = true;
      return commandResult(command, args, "");
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  const result = await installHarness({
    harness: "codex",
    detection: {
      harness: "codex",
      detected: true,
      supported: true,
      executable: "codex",
      version: "1.2.0"
    },
    catalogPath
  }, { runCommand });

  assert.equal(result.result, "WARN");
  assert.ok(result.warnings.some((warning) => warning.code === "AUTH_REQUIRED"));
  assert.deepEqual(result.details.mcp_ownership, codexMcpOwnership());
  const addCall = calls.find((call) => call[1] === "mcp" && call[2] === "add");
  assert.ok(addCall);
  assert.equal(addCall.includes("--scopes"), false);
  assert.equal(addCall.some((part) => String(part).includes("callback")), false);
});

test("Codex accepts the current CLI nested transport schema and treats hidden auth metadata as a probe warning", async () => {
  const catalogPath = path.resolve("/tmp/agent-university/codex-current-schema");
  const runCommand = async (command, args) => {
    const joined = args.join(" ");
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, {
        marketplaces: [{ name: "agent-university", root: catalogPath }]
      });
    }
    if (joined === "plugin list --json") {
      return commandResult(command, args, { installed: [codexPluginEntry()] });
    }
    if (joined === "mcp get implant --json") {
      return commandResult(command, args, {
        name: REMOTE_MCP.name,
        transport: { type: "streamable_http", url: REMOTE_MCP.url },
        auth_status: "not_logged_in"
      });
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  const result = await installHarness({
    harness: "codex",
    detection: {
      harness: "codex",
      detected: true,
      supported: true,
      executable: "codex",
      version: "0.146.0"
    },
    catalogPath
  }, { runCommand });

  assert.equal(result.result, "WARN");
  assert.ok(result.warnings.some((warning) => warning.code === "AUTH_REQUIRED"));
  assert.ok(result.warnings.some((warning) =>
    warning.details?.reasons?.includes("oauth_client_id_unobservable")
  ));
});

test("Codex uninstall is a compare-before-write no-op when plugin, MCP, and marketplace are absent", async () => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (joined === "plugin list --json") {
      return commandResult(command, args, { installed: [] });
    }
    if (joined === "mcp get implant --json") {
      return commandResult(command, args, "implant not found", 1);
    }
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, { marketplaces: [] });
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  const result = await uninstallHarness({
    harness: "codex",
    detection: { detected: true, supported: true, executable: "codex", version: "1.2.0" },
    catalogPath: "/tmp/absent-catalog"
  }, { runCommand });

  assert.equal(result.result, "PASS");
  assert.equal(result.changed, false);
  assert.equal(calls.some((call) => call.includes("remove")), false);
  assert.equal(result.details.catalog_removal.state, "absent");
});

test("Codex uninstall preserves a canonical but unowned same-name MCP", async () => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (joined === "plugin list --json") {
      return commandResult(command, args, { installed: [] });
    }
    if (joined === "mcp get implant --json") {
      return commandResult(command, args, {
        name: REMOTE_MCP.name,
        url: REMOTE_MCP.url,
        oauth_client_id: REMOTE_MCP.oauth.clientId
      });
    }
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, { marketplaces: [] });
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  const result = await uninstallHarness({
    harness: "codex",
    detection: { detected: true, supported: true, executable: "codex", version: "1.2.0" },
    catalogPath: "/tmp/absent-catalog"
  }, { runCommand });

  assert.equal(result.result, "WARN");
  assert.equal(result.changed, false);
  assert.equal(result.details.mcp_removal.state, "preserved_unproven");
  assert.equal(calls.some((call) => call.join(" ") === "codex mcp remove implant"), false);
});

test("Codex uninstall removes and verifies an installer-owned canonical MCP", async () => {
  const calls = [];
  let mcpPresent = true;
  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (joined === "plugin list --json") {
      return commandResult(command, args, { installed: [] });
    }
    if (joined === "mcp get implant --json") {
      return mcpPresent
        ? commandResult(command, args, {
            name: REMOTE_MCP.name,
            url: REMOTE_MCP.url,
            oauth_client_id: REMOTE_MCP.oauth.clientId
          })
        : commandResult(command, args, "implant not found", 1);
    }
    if (joined === "mcp remove implant") {
      mcpPresent = false;
      return commandResult(command, args, "");
    }
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, { marketplaces: [] });
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  const result = await uninstallHarness({
    harness: "codex",
    detection: { detected: true, supported: true, executable: "codex", version: "1.2.0" },
    catalogPath: "/tmp/absent-catalog",
    mcpOwnership: codexMcpOwnership()
  }, { runCommand });

  assert.equal(result.result, "PASS");
  assert.equal(result.changed, true);
  assert.equal(result.details.mcp_removal.state, "removed");
  assert.equal(calls.filter((call) => call.join(" ") === "codex mcp get implant --json").length, 2);
});

test("uninstall reports native nonzero and post-state verification failures", async (t) => {
  await t.test("native nonzero", async () => {
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, ...args]);
      const joined = args.join(" ");
      if (joined === "plugin list --json") {
        return commandResult(command, args, { installed: [codexPluginEntry()] });
      }
      if (joined === `plugin remove ${PLUGIN_ID} --json`) {
        return commandResult(command, args, "remove denied", 9);
      }
      throw new Error(`unexpected command: ${joined}`);
    };

    const result = await uninstallHarness({
      harness: "codex",
      detection: { detected: true, supported: true, executable: "codex", version: "1.2.0" },
      catalogPath: "/tmp/catalog",
      mcpOwnership: codexMcpOwnership()
    }, { runCommand });

    assert.equal(result.result, "FAIL");
    assert.equal(result.changed, false);
    assert.equal(result.details.plugin_removal.state, "remove_failed");
    assert.equal(calls.some((call) => call[1] === "mcp"), false);
  });

  await t.test("post-state still present", async () => {
    let listCount = 0;
    const runCommand = async (command, args) => {
      const joined = args.join(" ");
      if (joined === "plugin list --json") {
        listCount += 1;
        return commandResult(command, args, { installed: [codexPluginEntry()] });
      }
      if (joined === `plugin remove ${PLUGIN_ID} --json`) {
        return commandResult(command, args, "");
      }
      throw new Error(`unexpected command: ${joined}`);
    };

    const result = await uninstallHarness({
      harness: "codex",
      detection: { detected: true, supported: true, executable: "codex", version: "1.2.0" },
      catalogPath: "/tmp/catalog",
      mcpOwnership: codexMcpOwnership()
    }, { runCommand });

    assert.equal(result.result, "FAIL");
    assert.equal(result.details.plugin_removal.state, "verification_failed");
    assert.equal(listCount, 2);
  });
});

test("Claude removes an exact unused marketplace and retains one with remaining dependents", async (t) => {
  const catalogPath = path.resolve("/tmp/agent-university/claude-catalog");

  await t.test("prior package version", async () => {
    let pluginInstalled = true;
    let marketplaceRegistered = true;
    const calls = [];
    const priorVersionEntry = {
      ...claudePluginEntry(),
      version: "0.9.0"
    };
    const runCommand = async (command, args) => {
      calls.push([command, ...args]);
      const joined = args.join(" ");
      if (joined === "plugin list --json") {
        return commandResult(command, args, pluginInstalled ? [priorVersionEntry] : []);
      }
      if (joined === `plugin uninstall ${PLUGIN_ID} --scope user --yes`) {
        pluginInstalled = false;
        return commandResult(command, args, "");
      }
      if (joined === "plugin marketplace list --json") {
        return commandResult(command, args, marketplaceRegistered ? [{
          name: "agent-university",
          path: catalogPath,
          installLocation: catalogPath
        }] : []);
      }
      if (joined === "plugin marketplace remove agent-university --scope user") {
        marketplaceRegistered = false;
        return commandResult(command, args, "");
      }
      throw new Error(`unexpected command: ${joined}`);
    };

    const result = await uninstallHarness({
      harness: "claude",
      detection: { detected: true, supported: true, executable: "claude", version: "2.1.0" },
      catalogPath
    }, { runCommand });

    assert.equal(result.result, "PASS");
    assert.equal(result.details.plugin_removal.state, "removed");
    assert.ok(calls.some((call) => call.join(" ") === `claude plugin uninstall ${PLUGIN_ID} --scope user --yes`));
  });

  await t.test("exact unused registration", async () => {
    const calls = [];
    let pluginInstalled = true;
    let marketplaceRegistered = true;
    const runCommand = async (command, args) => {
      calls.push([command, ...args]);
      const joined = args.join(" ");
      if (joined === "plugin list --json") {
        return commandResult(command, args, pluginInstalled ? [claudePluginEntry()] : []);
      }
      if (joined === `plugin uninstall ${PLUGIN_ID} --scope user --yes`) {
        pluginInstalled = false;
        return commandResult(command, args, "");
      }
      if (joined === "plugin marketplace list --json") {
        return commandResult(command, args, marketplaceRegistered ? [{
          name: "agent-university",
          path: catalogPath,
          installLocation: catalogPath
        }] : []);
      }
      if (joined === "plugin marketplace remove agent-university --scope user") {
        marketplaceRegistered = false;
        return commandResult(command, args, "");
      }
      throw new Error(`unexpected command: ${joined}`);
    };

    const result = await uninstallHarness({
      harness: "claude",
      detection: { detected: true, supported: true, executable: "claude", version: "2.1.0" },
      catalogPath
    }, { runCommand });

    assert.equal(result.result, "PASS");
    assert.equal(result.details.catalog_removal.state, "removed");
    assert.ok(calls.some((call) => call.join(" ") === "claude plugin marketplace remove agent-university --scope user"));
  });

  await t.test("remaining dependent", async () => {
    let pluginInstalled = true;
    const dependent = {
      id: "other-plugin@agent-university",
      scope: "user",
      enabled: true
    };
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, ...args]);
      const joined = args.join(" ");
      if (joined === "plugin list --json") {
        return commandResult(command, args, pluginInstalled
          ? [claudePluginEntry(), dependent]
          : [dependent]);
      }
      if (joined === `plugin uninstall ${PLUGIN_ID} --scope user --yes`) {
        pluginInstalled = false;
        return commandResult(command, args, "");
      }
      if (joined === "plugin marketplace list --json") {
        return commandResult(command, args, [{ name: "agent-university", path: catalogPath }]);
      }
      throw new Error(`unexpected command: ${joined}`);
    };

    const result = await uninstallHarness({
      harness: "claude",
      detection: { detected: true, supported: true, executable: "claude", version: "2.1.0" },
      catalogPath
    }, { runCommand });

    assert.equal(result.result, "WARN");
    assert.equal(result.details.catalog_removal.state, "retained_for_dependents");
    assert.equal(calls.some((call) => call.join(" ").includes("marketplace remove")), false);
  });
});

test("the production installer performs a fresh one-command install and a no-op rerun without Git", async (t) => {
  const sandbox = await makeSandbox(t, "bios-install-");
  const stateRoot = path.join(sandbox, "state");
  const claudeExecutable = await makeExecutable(path.join(sandbox, "bin", "claude"));
  const catalogPath = path.join(stateRoot, "bios-implant", "catalog");
  const calls = [];
  let marketplaceInstalled = false;
  let pluginInstalled = false;

  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (joined === "--version") {
      return commandResult(command, args, "2.1.0\n");
    }
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, marketplaceInstalled ? [{
        name: "agent-university",
        source: "directory",
        path: catalogPath,
        installLocation: catalogPath
      }] : []);
    }
    if (joined === `plugin marketplace add ${catalogPath} --scope user`) {
      marketplaceInstalled = true;
      return commandResult(command, args, "");
    }
    if (joined === "plugin list --json") {
      return commandResult(command, args, pluginInstalled ? [claudePluginEntry()] : []);
    }
    if (joined === `plugin install ${PLUGIN_ID} --scope user`) {
      pluginInstalled = true;
      return commandResult(command, args, "");
    }
    throw new Error(`unexpected command: ${joined}`);
  };
  const deps = {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: {
      BIOS_IMPLANT_STATE_ROOT: stateRoot,
      HOME: path.dirname(stateRoot),
      PATH: "/fixture/bin"
    },
    resolveExecutable: (command) => command === "claude" ? claudeExecutable : null,
    runCommand
  };
  const options = { yes: true, timeoutSeconds: 5, harnesses: [] };
  const malformedBindingPath = path.join(stateRoot, "bios", "projects", "broken", "binding.json");
  await fsp.mkdir(path.dirname(malformedBindingPath), { recursive: true });
  await fsp.writeFile(malformedBindingPath, "{not-json", "utf8");

  const first = await runInstaller("install", options, deps);
  const callsAfterFirst = calls.length;
  const second = await runInstaller("install", options, deps);

  assert.equal(first.exit_code, 0);
  assert.equal(first.status, "WARN");
  assert.equal(first.changed, true);
  assert.ok(first.warnings.some((warning) => warning.code === "BINDING_INSPECTION_FAILED"));
  assert.equal(second.exit_code, 0);
  assert.equal(second.changed, false);
  assert.ok(calls.slice(callsAfterFirst).every((call) => !call.includes("add") && !call.includes("install")));
  assert.equal(calls.some((call) => call[0] === "git" || call.includes("git")), false);

  const installStatePath = path.join(stateRoot, "bios-implant", "install-state.json");
  const installState = JSON.parse(await fsp.readFile(installStatePath, "utf8"));
  assert.equal(installState.package_name, PACKAGE_NAME);
  if (process.platform !== "win32") {
    assert.equal((await fsp.stat(installStatePath)).mode & 0o077, 0);
  }
});

test("PATH-scrubbed macOS detection verifies a known user CLI path and never executes the app bundle", async (t) => {
  const sandbox = await makeSandbox(t, "bios-detect-mac-");
  const homeDirectory = path.join(sandbox, "home");
  const executable = await makeExecutable(path.join(homeDirectory, ".local", "bin", "claude"));
  const calls = [];
  const result = await detectHarnesses({ homeDirectory }, {
    platform: "darwin",
    env: { HOME: homeDirectory, PATH: path.join(sandbox, "empty") },
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return commandResult(command, args, "claude 2.1.0\n");
    }
  });

  assert.equal(result.byHarness.claude.executable, executable);
  assert.equal(result.byHarness.claude.supported, true);
  assert.equal(result.byHarness.cowork.required_version, "2.1.220");
  assert.equal(result.byHarness.cowork.supported, false);
  assert.equal(result.byHarness.cowork.upgrade_required, true);
  assert.deepEqual(calls, [[executable, "--version"]]);
  assert.equal(calls.some((call) => call[0].includes("Claude.app/Contents/MacOS/Claude")), false);
});

test("Local Cowork automatic registration requires a current Claude CLI and Desktop app", async (t) => {
  const sandbox = await makeSandbox(t, "bios-detect-cowork-");
  const homeDirectory = path.join(sandbox, "home");
  const executable = await makeExecutable(path.join(homeDirectory, ".local", "bin", "claude"));
  await fsp.mkdir(path.join(homeDirectory, "Applications", "Claude.app"), { recursive: true });

  const result = await detectHarnesses({ homeDirectory }, {
    platform: "darwin",
    env: { HOME: homeDirectory, PATH: path.join(sandbox, "empty") },
    runCommand: async (command, args) => commandResult(command, args, "claude 2.1.220\n")
  });

  assert.equal(result.byHarness.cowork.app_present, true);
  assert.equal(result.byHarness.cowork.executable, executable);
  assert.equal(result.byHarness.cowork.required_version, "2.1.220");
  assert.equal(result.byHarness.cowork.supported, true);
  assert.equal(result.byHarness.cowork.cowork_ready, true);
});

test("current Codex 0.146 release is accepted as a supported harness", async (t) => {
  const sandbox = await makeSandbox(t, "bios-detect-codex-");
  const homeDirectory = path.join(sandbox, "home");
  const executable = await makeExecutable(path.join(sandbox, "bin", "codex"));
  const calls = [];
  const result = await detectHarnesses({ homeDirectory }, {
    platform: "linux",
    env: { HOME: homeDirectory, PATH: path.join(sandbox, "empty") },
    resolveExecutable: (command) => command === "codex" ? executable : null,
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return commandResult(command, args, "codex-cli 0.146.0\n");
    }
  });

  assert.equal(result.byHarness.codex.executable, executable);
  assert.equal(result.byHarness.codex.version, "0.146.0");
  assert.equal(result.byHarness.codex.required_version, "0.146.0");
  assert.equal(result.byHarness.codex.supported, true);
  assert.deepEqual(calls, [[executable, "--version"]]);
});

test("explicit missing doctor harness is a HARNESS_NOT_DETECTED failure", async () => {
  const result = await doctorHarness({ harness: "codex", detection: undefined });
  assert.equal(result.result, "FAIL");
  assert.equal(result.code, "HARNESS_NOT_DETECTED");
  assert.equal(result.checks[0].result, "FAIL");
  assert.equal(result.checks[0].code, "HARNESS_NOT_DETECTED");
});

test("installer persists Codex MCP ownership and later removes owned native state plus catalog", async (t) => {
  const sandbox = await makeSandbox(t, "bios-owned-lifecycle-");
  const stateRoot = path.join(sandbox, "state");
  const catalogPath = path.join(stateRoot, "bios-implant", "catalog");
  const executable = await makeExecutable(path.join(sandbox, "bin", "codex"));
  let marketplaceRegistered = false;
  let pluginInstalled = false;
  let mcpPresent = false;
  const calls = [];

  const runCommand = async (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (joined === "--version") {
      return commandResult(command, args, "codex 1.2.0\n");
    }
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, {
        marketplaces: marketplaceRegistered
          ? [{ name: "agent-university", root: catalogPath }]
          : []
      });
    }
    if (joined === `plugin marketplace add ${catalogPath} --json`) {
      marketplaceRegistered = true;
      return commandResult(command, args, "");
    }
    if (joined === "plugin marketplace remove agent-university --json") {
      marketplaceRegistered = false;
      return commandResult(command, args, "");
    }
    if (joined === "plugin list --json") {
      return commandResult(command, args, { installed: pluginInstalled ? [codexPluginEntry()] : [] });
    }
    if (joined === `plugin add ${PLUGIN_ID} --json`) {
      pluginInstalled = true;
      return commandResult(command, args, "");
    }
    if (joined === `plugin remove ${PLUGIN_ID} --json`) {
      pluginInstalled = false;
      return commandResult(command, args, "");
    }
    if (joined === "mcp get implant --json") {
      return mcpPresent
        ? commandResult(command, args, {
            name: REMOTE_MCP.name,
            url: REMOTE_MCP.url,
            oauth_client_id: REMOTE_MCP.oauth.clientId
          })
        : commandResult(command, args, "implant not found", 1);
    }
    if (joined === `mcp add implant --url ${REMOTE_MCP.url} --oauth-client-id ${REMOTE_MCP.oauth.clientId}`) {
      mcpPresent = true;
      return commandResult(command, args, "");
    }
    if (joined === "mcp remove implant") {
      mcpPresent = false;
      return commandResult(command, args, "");
    }
    throw new Error(`unexpected command: ${joined}`);
  };
  const deps = {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: {
      BIOS_IMPLANT_STATE_ROOT: stateRoot,
      HOME: sandbox,
      PATH: path.join(sandbox, "empty")
    },
    resolveExecutable: (command) => command === "codex" ? executable : null,
    runCommand
  };

  const installed = await runInstaller("install", { yes: true, harnesses: ["codex"] }, deps);
  assert.equal(installed.status, "WARN");
  const installStatePath = path.join(stateRoot, "bios-implant", "install-state.json");
  const installState = JSON.parse(await fsp.readFile(installStatePath, "utf8"));
  assert.deepEqual(installState.ownership.codex_mcp, codexMcpOwnership());
  assert.deepEqual(
    installState.ownership.codex_oauth_callback.inserted_keys.sort(),
    ["mcp_oauth_callback_port", "mcp_oauth_callback_url"]
  );
  const codexConfigPath = path.join(sandbox, ".codex", "config.toml");
  const installedCodexConfig = await fsp.readFile(codexConfigPath, "utf8");
  assert.match(installedCodexConfig, /mcp_oauth_callback_port = 8486/u);
  assert.match(installedCodexConfig, /mcp_oauth_callback_url = "http:\/\/127\.0\.0\.1:8486\/callback"/u);

  const uninstalled = await runInstaller("uninstall", { yes: true, harnesses: ["codex"] }, deps);
  assert.equal(uninstalled.status, "PASS");
  assert.equal(uninstalled.harnesses[0].details.mcp_removal.state, "removed");
  assert.equal(uninstalled.harnesses[0].details.catalog_removal.state, "removed");
  assert.equal(uninstalled.actions.find((action) => action.type === "remove_catalog").state, "removed");
  await assert.rejects(fsp.access(catalogPath), { code: "ENOENT" });
  await assert.rejects(fsp.access(installStatePath), { code: "ENOENT" });
  assert.doesNotMatch(await fsp.readFile(codexConfigPath, "utf8"), /mcp_oauth_callback_/u);
  assert.ok(calls.some((call) => call.slice(1).join(" ") === "plugin marketplace remove agent-university --json"));
});

test("installer retains persistent catalog when a previously installed harness was not safely removed", async (t) => {
  const sandbox = await makeSandbox(t, "bios-retain-catalog-");
  const stateRoot = path.join(sandbox, "state");
  const catalogPath = path.join(stateRoot, "bios-implant", "catalog");
  const installStatePath = path.join(stateRoot, "bios-implant", "install-state.json");
  const executable = await makeExecutable(path.join(sandbox, "bin", "claude"));
  await fsp.mkdir(catalogPath, { recursive: true });
  await fsp.writeFile(path.join(catalogPath, "fixture.txt"), "owned\n", "utf8");
  await fsp.writeFile(installStatePath, JSON.stringify({
    package_name: PACKAGE_NAME,
    package_version: PACKAGE_VERSION,
    catalog_path: catalogPath,
    harnesses: [
      { harness: "claude", result: "PASS", code: "OK" },
      { harness: "codex", result: "WARN", code: "AUTH_REQUIRED" }
    ],
    ownership: { codex_mcp: codexMcpOwnership() }
  }), "utf8");
  let marketplaceRegistered = true;
  const runCommand = async (command, args) => {
    const joined = args.join(" ");
    if (joined === "--version") {
      return commandResult(command, args, "claude 2.1.0\n");
    }
    if (joined === "plugin list --json") {
      return commandResult(command, args, []);
    }
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, marketplaceRegistered
        ? [{ name: "agent-university", path: catalogPath }]
        : []);
    }
    if (joined === "plugin marketplace remove agent-university --scope user") {
      marketplaceRegistered = false;
      return commandResult(command, args, "");
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  const result = await runInstaller("uninstall", { yes: true, harnesses: ["claude"] }, {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: { BIOS_IMPLANT_STATE_ROOT: stateRoot, HOME: sandbox, PATH: path.join(sandbox, "empty") },
    resolveExecutable: (command) => command === "claude" ? executable : null,
    runCommand
  });

  assert.equal(result.status, "WARN");
  assert.equal(result.actions.find((action) => action.type === "retain_catalog").state, "registration_retained");
  await fsp.access(catalogPath);
  await fsp.access(installStatePath);
});

test("uninstall fails closed before reading or deleting through a symlinked managed parent", async (t) => {
  const sandbox = await makeSandbox(t, "bios-catalog-symlink-");
  const stateRoot = path.join(sandbox, "state");
  const outsideInstallHome = path.join(sandbox, "outside-install-home");
  const installHome = path.join(stateRoot, "bios-implant");
  const catalogPath = path.join(installHome, "catalog");
  const outsideCatalogPath = path.join(outsideInstallHome, "catalog");
  const installStatePath = path.join(outsideInstallHome, "install-state.json");
  const executable = await makeExecutable(path.join(sandbox, "bin", "claude"));

  await fsp.mkdir(outsideCatalogPath, { recursive: true });
  await fsp.writeFile(path.join(outsideCatalogPath, "fixture.txt"), "preserve\n", "utf8");
  await fsp.writeFile(installStatePath, JSON.stringify({
    package_name: PACKAGE_NAME,
    package_version: PACKAGE_VERSION,
    catalog_path: catalogPath,
    harnesses: [{ harness: "claude", result: "PASS", code: "OK" }]
  }), "utf8");
  await fsp.mkdir(stateRoot, { recursive: true });
  await fsp.symlink(outsideInstallHome, installHome, "dir");

  let marketplaceRegistered = true;
  let commandCalls = 0;
  const runCommand = async (command, args) => {
    commandCalls += 1;
    const joined = args.join(" ");
    if (joined === "--version") {
      return commandResult(command, args, "claude 2.1.0\n");
    }
    if (joined === "plugin list --json") {
      return commandResult(command, args, []);
    }
    if (joined === "plugin marketplace list --json") {
      return commandResult(command, args, marketplaceRegistered
        ? [{ name: "agent-university", path: catalogPath }]
        : []);
    }
    if (joined === "plugin marketplace remove agent-university --scope user") {
      marketplaceRegistered = false;
      return commandResult(command, args, "");
    }
    throw new Error(`unexpected command: ${joined}`);
  };

  const result = await runInstaller("uninstall", { yes: true, harnesses: ["claude"] }, {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: { BIOS_IMPLANT_STATE_ROOT: stateRoot, HOME: sandbox, PATH: path.join(sandbox, "empty") },
    resolveExecutable: (command) => command === "claude" ? executable : null,
    runCommand
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.warnings[0].code, "UNSAFE_STATE_PATH");
  assert.equal(result.warnings[0].details.reason, "symlink_traversal");
  assert.equal(commandCalls, 0);
  assert.equal(marketplaceRegistered, true);
  assert.equal(await fsp.readFile(path.join(outsideCatalogPath, "fixture.txt"), "utf8"), "preserve\n");
  await fsp.access(installStatePath);
});

test("purge retains a ledger target reached through a symlinked parent", async (t) => {
  const sandbox = await makeSandbox(t, "bios-purge-symlink-");
  const stateRoot = path.join(sandbox, "state");
  const outsideRoot = path.join(sandbox, "outside");
  const linkedParent = path.join(stateRoot, "bios", "projects", "escape");
  const outsideFile = path.join(outsideRoot, "secret.txt");
  const ledgerPath = path.join(stateRoot, "bios-implant", "owned-state.jsonl");
  await fsp.mkdir(outsideRoot, { recursive: true });
  await fsp.writeFile(outsideFile, "do not delete\n", "utf8");
  await fsp.mkdir(path.dirname(linkedParent), { recursive: true });
  await fsp.symlink(outsideRoot, linkedParent, "dir");
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  const digest = crypto.createHash("sha256").update(await fsp.readFile(outsideFile)).digest("hex");
  await fsp.writeFile(ledgerPath, `${JSON.stringify({
    schema_version: 1,
    owner: PACKAGE_NAME,
    relative_path: "bios/projects/escape/secret.txt",
    kind: "fixture",
    digest_sha256: digest
  })}\n`, "utf8");

  const result = await runInstaller("uninstall", {
    yes: true,
    harnesses: [],
    purgeData: true
  }, {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: { BIOS_IMPLANT_STATE_ROOT: stateRoot, HOME: sandbox, PATH: path.join(sandbox, "empty") },
    resolveExecutable: () => null
  });

  await fsp.access(outsideFile);
  const purgeAction = result.actions.find((action) => action.type === "purged_owned_state");
  assert.equal(purgeAction.deleted_count, 0);
  assert.equal(purgeAction.retained_count, 1);
});

test("auto install exits 3 without creating state when no harness is detected", async (t) => {
  const stateRoot = path.join(await makeSandbox(t, "bios-no-harness-"), "state");
  const result = await runInstaller("install", { yes: true, harnesses: [] }, {
    packageRoot: PACKAGE_ROOT,
    platform: "linux",
    env: {
      BIOS_IMPLANT_STATE_ROOT: stateRoot,
      HOME: path.dirname(stateRoot),
      PATH: "/empty"
    },
    resolveExecutable: () => null
  });

  assert.equal(result.exit_code, 3);
  assert.equal(result.status, "FAIL");
  await assert.rejects(fsp.access(stateRoot), { code: "ENOENT" });
});
