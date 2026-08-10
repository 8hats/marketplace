import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function readPackageFile(...segments) {
  return fsp.readFile(path.join(packageRoot, ...segments), "utf8");
}

test("npm README exposes an autonomous Local Cowork bootstrap contract", async () => {
  const readme = await readPackageFile("README.md");

  assert.match(readme, /## Agent bootstrap for Local Cowork/);
  assert.match(readme, /https:\/\/app\.agents\.university\/bios-implant\/SETUP\.md/);
  assert.match(readme, /fetch and follow the public setup document first/i);
  assert.match(readme, /Remote Cowork is unsupported/i);
  assert.match(readme, /Computer Use/);
  assert.match(readme, /host Terminal/i);
  assert.match(
    readme,
    /npx -y @agentuniversity\/bios-implant@latest install --yes --harness cowork/
  );
  assert.match(readme, /Report:.*file:\/\//is);
  assert.match(readme, /skills\/install\/SKILL\.md/);
});

test("install skill owns the full background install, doctor, and handoff workflow", async () => {
  const skill = await readPackageFile("skills", "install", "SKILL.md");
  const metadata = await readPackageFile("skills", "install", "agents", "openai.yaml");

  assert.match(skill, /^---\nname: install\n/m);
  assert.match(skill, /Local Cowork/);
  assert.match(skill, /pastes? (?:the )?npm command/i);
  assert.match(skill, /request.*permission/i);
  assert.match(skill, /Computer Use/);
  assert.match(skill, /Terminal\.app/);
  assert.match(
    skill,
    /npx -y @agentuniversity\/bios-implant@latest install --yes --harness cowork/
  );
  assert.match(skill, /npx -y @agentuniversity\/bios-implant@latest doctor/);
  assert.match(skill, /saved JSON report/i);
  assert.match(skill, /AUTH_REQUIRED/);
  assert.match(skill, /BINDING_REQUIRED/);
  assert.match(skill, /new Local Cowork session/i);
  assert.match(metadata, /default_prompt: ".*\$install/);
});

test("Cowork receives the native post-install SETUP.md skill", async () => {
  const setup = await readPackageFile("SETUP.md");

  assert.match(setup, /^# BIOS Implant Setup/m);
  assert.match(setup, /Local Cowork/);
  assert.match(setup, /Computer Use/);
  assert.match(setup, /Node is version 20 or newer/);
  assert.match(
    setup,
    /npx -y @agentuniversity\/bios-implant@latest install --yes --harness cowork/
  );
  assert.match(setup, /registration_state: "installed_and_verified"/);
  assert.doesNotMatch(setup, /COWORK_CONFIRMATION_REQUIRED/);
  assert.doesNotMatch(setup, /claude:\/\/cowork\/new/);
  assert.match(setup, /npx -y @agentuniversity\/bios-implant@latest doctor/);
  assert.match(setup, /Error report:/);
  assert.match(setup, /doctor/);
  assert.match(setup, /OAuth/);
  assert.match(setup, /connect/);
  assert.match(setup, /one-use setup URL/);
  assert.match(setup, /READY/);
  assert.match(setup, /INSTALLED/);
  assert.match(setup, /BLOCKED/);
});

test("package metadata advertises the Cowork installer rather than a generic package shell", async () => {
  const manifest = JSON.parse(await readPackageFile("package.json"));

  assert.match(manifest.description, /Local Cowork/i);
  assert.match(manifest.description, /install/i);
  assert.equal(manifest.bin["bios-install"], "bin/bios-install.mjs");
});

test("doctor skill requires runtime evidence and a human-readable health table", async () => {
  const skill = await readPackageFile("skills", "doctor", "SKILL.md");

  assert.match(skill, /resolve tools by capability.*not by server display name/i);
  assert.match(skill, /Do not report missing authentication from.*pending.*needs.auth/i);
  assert.match(skill, /actual `bios_load` call returns an authentication error/i);
  assert.match(skill, /Do not claim that local state is healthy when the local probes did not run/i);
  assert.match(skill, /\| Check \| Status \| Evidence \|/);
  assert.match(skill, /✅ PASS/);
  assert.match(skill, /⚠️ PARTIAL/);
  assert.match(skill, /❌ FAIL/);
  assert.match(skill, /⏭️ NOT CHECKED/);
});

test("connect skill routes one-use activation through the native local companion", async () => {
  const skill = await readPackageFile("skills", "connect", "SKILL.md");

  assert.match(skill, /Pass the owner-provided setup URL exactly once to `local_activate`/);
  assert.match(skill, /perform its single activation request from the native host/);
  assert.match(skill, /do not reconstruct or run its `curl` command/i);
  assert.match(skill, /Never use workspace shell, `curl`, Web Fetch, or browser automation for activation/);
});

test("every Codex skill prompt names its skill", async () => {
  for (const skill of ["boot", "connect", "doctor", "install"]) {
    const metadata = await readPackageFile("skills", skill, "agents", "openai.yaml");
    assert.match(metadata, new RegExp(`default_prompt: ".*\\$${skill}\\b`));
  }
});
