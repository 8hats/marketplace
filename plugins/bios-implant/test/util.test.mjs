import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "../src/util.mjs";

test("runCommand returns structured output for a successful child", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok\\n')"], {
    timeoutMs: 2_000
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok\n");
  assert.equal(result.timedOut, false);
});

test("runCommand hard-bounds a child that ignores SIGTERM", async () => {
  const startedAt = Date.now();
  let observedError;

  try {
    await runCommand(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"
    ], {
      timeoutMs: 300,
      terminationGraceMs: 75
    });
    assert.fail("expected the command to time out");
  } catch (error) {
    observedError = error;
  }

  const elapsedMs = Date.now() - startedAt;
  assert.equal(observedError.code, "COMMAND_TIMEOUT");
  assert.equal(observedError.result.timedOut, true);
  assert.match(observedError.result.stdout, /ready/);
  assert.ok(elapsedMs < 1_500, `timeout was not wall-clock bounded: ${elapsedMs}ms`);
});
