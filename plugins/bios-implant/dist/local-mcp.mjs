#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/local-companion.mjs";

function canonicalPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

const isEntrypoint = process.argv[1]
  && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
