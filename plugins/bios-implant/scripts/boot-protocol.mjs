#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_STDIN_BYTES = 64 * 1024;

export const EXIT_SUCCESS = 0;
export const EXIT_MALFORMED = 1;
export const EXIT_OVERSIZED = 2;

export const DEFAULT_ADDITIONAL_CONTEXT =
  "Run the BIOS Implant `boot` skill/protocol before substantive work: call `local_selection` for the exact current folder; if unbound, stop and run `connect`; if bound, call `bios_load` for that agent, then `local_stage` with the returned BIOS body/version/etag metadata, then `wm_load`. On BIOS auth or network failure, consult `local_status` and use local fallback only if it returns a valid last-good BIOS body or context. Finish by reporting `LOADED`, `PARTIAL`, or `UNAVAILABLE`.";

export function buildAdditionalContext() {
  return DEFAULT_ADDITIONAL_CONTEXT;
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
} = {}) {
  try {
    const text = await readBoundedStdin(stdin);
    parseHookEventText(text);
    stdout.write(`${JSON.stringify(buildSessionStartPayload())}\n`);
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
