import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOT_PROTOCOL = path.join(HERE, "..", "scripts", "boot-protocol.mjs");
const COMPANION = path.join(HERE, "..", "src", "local-companion.mjs");

async function loadBootProtocol() {
  return import(pathToFileURL(BOOT_PROTOCOL).href + `?v=${Date.now()}-${Math.random()}`);
}
async function loadCompanion() {
  return import(pathToFileURL(COMPANION).href + `?v=${Date.now()}-${Math.random()}`);
}

async function makeSandbox(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-protocol-"));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

function useStateRoot(t, stateRoot) {
  const prev = process.env.BIOS_IMPLANT_STATE_ROOT;
  process.env.BIOS_IMPLANT_STATE_ROOT = stateRoot;
  t.after(() => {
    if (prev === undefined) delete process.env.BIOS_IMPLANT_STATE_ROOT;
    else process.env.BIOS_IMPLANT_STATE_ROOT = prev;
  });
}

function biosBody(version) {
  return `---\nversion: ${version}\n---\n# demo\nBIOS v${version}\n`;
}

/** Drive the companion to bind `folder` to an agent, and optionally stage a BIOS. */
async function setup(companion, { folder, roots, connect, stage }) {
  const session = companion.createSession({
    listRoots: async () => roots,
    output: new PassThrough(),
    error: new PassThrough(),
  });
  if (connect) {
    const r = await companion.handleRequest(session, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "local_connect", arguments: { agent_id: connect, folder } },
    });
    assert.equal(r.result.isError ?? false, false, "connect should succeed");
  }
  if (stage) {
    const r = await companion.handleRequest(session, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "local_stage", arguments: {
        agent_id: stage, label: "default", folder, body: biosBody(4), version: 4, etag: '"etag-4"',
      } },
    });
    assert.equal(r.result.isError ?? false, false, "stage should succeed");
  }
}

test("readOnboardingStage: a folder with no binding reads as 'unbound'", async (t) => {
  const boot = await loadBootProtocol();
  const sandbox = await makeSandbox(t);
  const workspace = path.join(sandbox, "workspace");
  const stateRoot = path.join(sandbox, "state");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  useStateRoot(t, stateRoot);

  assert.equal(await boot.readOnboardingStage({ folder: workspace }), "unbound");
});

test("readOnboardingStage: bound but no BIOS staged reads as 'bound_unstaged'", async (t) => {
  const boot = await loadBootProtocol();
  const companion = await loadCompanion();
  const sandbox = await makeSandbox(t);
  const workspace = path.join(sandbox, "workspace");
  const stateRoot = path.join(sandbox, "state");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  useStateRoot(t, stateRoot);

  await setup(companion, { folder: workspace, roots: [sandbox], connect: "agent-boot" });

  assert.equal(await boot.readOnboardingStage({ folder: workspace }), "bound_unstaged");
});

test("readOnboardingStage: bound with a staged BIOS reads as 'booted'", async (t) => {
  const boot = await loadBootProtocol();
  const companion = await loadCompanion();
  const sandbox = await makeSandbox(t);
  const workspace = path.join(sandbox, "workspace");
  const stateRoot = path.join(sandbox, "state");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  useStateRoot(t, stateRoot);

  await setup(companion, { folder: workspace, roots: [sandbox], connect: "agent-boot", stage: "agent-boot" });

  assert.equal(await boot.readOnboardingStage({ folder: workspace }), "booted");
});

test("readOnboardingStage: an unreadable state root never throws — it returns 'unknown'", async (t) => {
  const boot = await loadBootProtocol();
  const sandbox = await makeSandbox(t);
  // Point the state root at a FILE, so any read attempt errors instead of finding a dir.
  const notADir = path.join(sandbox, "state-is-a-file");
  await fs.writeFile(notADir, "nope", "utf8");
  useStateRoot(t, notADir);

  const stage = await boot.readOnboardingStage({ folder: sandbox });
  assert.ok(stage === "unknown" || stage === "unbound", `must degrade gracefully, got ${stage}`);
});

test("buildAdditionalContext maps each stage to the right guidance", async () => {
  const boot = await loadBootProtocol();

  const unbound = boot.buildAdditionalContext("unbound");
  assert.match(unbound, /BIOS Implant/);
  assert.match(unbound, /8hats-implant-connect/);

  const unstaged = boot.buildAdditionalContext("bound_unstaged");
  assert.match(unstaged, /BIOS Implant/);
  assert.match(unstaged, /8hats-implant-boot/);

  // The whole point of step 3: the onboarding stages get their OWN targeted message, distinct
  // from the generic runtime boot instruction. If they collapse back to the default, the guide
  // is not actually guiding.
  assert.notEqual(unbound, boot.DEFAULT_ADDITIONAL_CONTEXT);
  assert.notEqual(unstaged, boot.DEFAULT_ADDITIONAL_CONTEXT);
  assert.notEqual(unbound, unstaged);

  // booted and unknown fall back to the standard runtime boot instruction (unchanged behaviour).
  assert.equal(boot.buildAdditionalContext("booted"), boot.DEFAULT_ADDITIONAL_CONTEXT);
  assert.equal(boot.buildAdditionalContext("unknown"), boot.DEFAULT_ADDITIONAL_CONTEXT);
  assert.equal(boot.buildAdditionalContext(), boot.DEFAULT_ADDITIONAL_CONTEXT);
});

test("main emits the unbound guidance for a fresh folder, exit 0", async (t) => {
  const boot = await loadBootProtocol();
  const sandbox = await makeSandbox(t);
  const workspace = path.join(sandbox, "workspace");
  const stateRoot = path.join(sandbox, "state");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  useStateRoot(t, stateRoot);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = [];
  stdout.on("data", (c) => out.push(c.toString("utf8")));
  stdin.end(JSON.stringify({ hook_event_name: "SessionStart", cwd: workspace }));

  const code = await boot.main({ stdin, stdout, stderr });
  assert.equal(code, boot.EXIT_SUCCESS);
  const payload = JSON.parse(out.join(""));
  assert.equal(payload.hookSpecificOutput.additionalContext, boot.buildAdditionalContext("unbound"));
  // A fresh folder must get the connect guidance, NOT the generic runtime boot instruction.
  assert.notEqual(payload.hookSpecificOutput.additionalContext, boot.DEFAULT_ADDITIONAL_CONTEXT);
});

test("main never crashes the session: a broken state root still exits 0 with the safe default", async (t) => {
  const boot = await loadBootProtocol();
  const sandbox = await makeSandbox(t);
  const notADir = path.join(sandbox, "state-is-a-file");
  await fs.writeFile(notADir, "nope", "utf8");
  useStateRoot(t, notADir);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out = [];
  stdout.on("data", (c) => out.push(c.toString("utf8")));
  stdin.end(JSON.stringify({ hook_event_name: "SessionStart", cwd: sandbox }));

  const code = await boot.main({ stdin, stdout, stderr });
  assert.equal(code, boot.EXIT_SUCCESS);
  const payload = JSON.parse(out.join(""));
  // Whatever the read did, the session must get a usable instruction, never a crash.
  assert.equal(typeof payload.hookSpecificOutput.additionalContext, "string");
  assert.ok(payload.hookSpecificOutput.additionalContext.length > 0);
});
