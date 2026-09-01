#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBindingRecord, localStatus, resolveStateRootForRead } from "../src/store.mjs";

const MAX_STDIN_BYTES = 64 * 1024;

export const EXIT_SUCCESS = 0;
export const EXIT_MALFORMED = 1;
export const EXIT_OVERSIZED = 2;

export const DEFAULT_ADDITIONAL_CONTEXT =
  "Run the BIOS Implant `8hats-implant-boot` skill/protocol before substantive work: call `local_selection` for the exact current folder; if unbound, stop and run `8hats-implant-connect`; if bound, call `bios_load` for that agent, then `local_stage` with the returned BIOS body/version/etag metadata, then `wm_load`. On BIOS auth or network failure, consult `local_status` and use local fallback only if it returns a valid last-good BIOS body or context. Finish by reporting `LOADED`, `PARTIAL`, or `UNAVAILABLE`.";

// Onboarding guidance, one message per state. The hook injects ONE of these at session start so
// the agent leads with a clear, branded next step instead of the jargon boot instruction — the
// L3/L4/L7 "silence at every transition" gap. `booted` and `unknown` keep the standard boot
// instruction unchanged: a set-up agent still needs it to load its BIOS each session (that is
// runtime, not onboarding).
export const GUIDANCE = {
  unbound:
    "BIOS Implant is installed but this folder is not connected to an agent yet. Before other "
    + "work, tell the user plainly that this is the one next step, then run the "
    + "`8hats-implant-connect` skill with the setup link they were given (from "
    + "app.agents.university). Do not improvise other steps — connect is the whole next action.",
  bound_unstaged:
    "BIOS Implant is connected to this folder, but no BIOS is loaded yet. Tell the user plainly "
    + "that the next step is to finish setup: the owner authorizes the BIOS source once (run the "
    + "`8hats-implant-doctor` skill to check authorization), then run the `8hats-implant-boot` "
    + "skill in a fresh session to load the BIOS. A BIOS that comes back `not found` is a normal "
    + "waiting state, not a failure.",
};

export function buildAdditionalContext(stage = "unknown") {
  if (stage === "unbound") return GUIDANCE.unbound;
  if (stage === "bound_unstaged") return GUIDANCE.bound_unstaged;
  return DEFAULT_ADDITIONAL_CONTEXT;
}

// Classify onboarding progress for `folder` from LOCAL STATE FILES ONLY — the companion process
// is never spawned and no network call is made, so the common already-set-up case is a couple of
// small reads and out. Any read failure degrades to `unknown` (→ the safe default instruction):
// a SessionStart hook must never crash a session, so an unreadable state is guidance-off, not an
// error.
export async function readOnboardingStage({ folder } = {}) {
  try {
    const workspaceRoot = folder ?? process.cwd();
    const stateRoot = await resolveStateRootForRead();
    const binding = await readBindingRecord({ workspaceRoot, stateRoot });
    if (!binding) return "unbound";
    const status = await localStatus({ agentId: binding.agent_id, label: binding.label });
    return status?.staged ? "booted" : "bound_unstaged";
  } catch {
    return "unknown";
  }
}

export function buildSessionStartPayload(additionalContext = buildAdditionalContext()) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

export function parseHookEventText(text) {
  if (text.length === 0) {
    return { kind: "empty", event: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error("Malformed hook input.");
    error.code = "MALFORMED";
    throw error;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("Malformed hook input.");
    error.code = "MALFORMED";
    throw error;
  }

  return { kind: "json", event: parsed };
}

export async function readBoundedStdin(stream, maxBytes = MAX_STDIN_BYTES) {
  const chunks = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > maxBytes) {
      const error = new Error("Hook input exceeded limit.");
      error.code = "OVERSIZED";
      throw error;
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function main({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd,
} = {}) {
  try {
    const text = await readBoundedStdin(stdin);
    const { event } = parseHookEventText(text);
    const folder = (typeof event?.cwd === "string" && event.cwd) ? event.cwd : (cwd ?? process.cwd());
    const stage = await readOnboardingStage({ folder });
    stdout.write(`${JSON.stringify(buildSessionStartPayload(buildAdditionalContext(stage)))}\n`);
    return EXIT_SUCCESS;
  } catch (error) {
    if (error?.code === "OVERSIZED") {
      stderr.write("boot-protocol: oversized hook input\n");
      return EXIT_OVERSIZED;
    }
    if (error?.code === "MALFORMED") {
      stderr.write("boot-protocol: malformed hook input\n");
      return EXIT_MALFORMED;
    }
    stderr.write("boot-protocol: internal failure\n");
    return EXIT_MALFORMED;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);

if (entryPath === modulePath) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
