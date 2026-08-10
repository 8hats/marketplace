#!/usr/bin/env node

import { runCli } from "../src/cli.mjs";
import { EXIT_CODE_FAILURE } from "../src/constants.mjs";
import { safeErrorMessage } from "../src/util.mjs";

try {
  const exitCode = await runCli(["install", ...process.argv.slice(2)]);
  if (Number.isInteger(exitCode)) {
    process.exitCode = exitCode;
  }
} catch (error) {
  console.error(safeErrorMessage(error));
  process.exitCode = EXIT_CODE_FAILURE;
}
