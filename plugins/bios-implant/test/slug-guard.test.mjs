import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// This test file sits at plugins/bios-implant/test/ ; three levels up is the repo root.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const RETIRED = "8hats/plugins";      // the moved-away marketplace slug (DEV-57)
const CURRENT = "8hats/marketplace";  // the one every install surface must teach

// A line may mention the retired slug ONLY when it is explicitly talking about the retirement
// itself (changelog history, "moved"/"retired" notes). Anywhere else, a live retired slug is the
// exact G1/G2 regression: it silently retargets the registry key because both repos' manifests
// still declare name "8hats".
const RETIRED_CONTEXT = /retired|moved|no longer|old slug|renamed|history/i;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".github"]);
const SCAN_EXT = new Set([".md", ".json", ".mjs"]);
// CHANGELOG is immutable history — past entries legitimately quote the old slug verbatim.
const EXEMPT_FILES = new Set(["plugins/bios-implant/CHANGELOG.md"]);

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await walk(path.join(dir, e.name))));
    } else if (SCAN_EXT.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

test("no live occurrence of the retired 8hats/plugins slug outside retirement-context", async () => {
  const files = await walk(repoRoot);
  const offenders = [];
  for (const abs of files) {
    const rel = path.relative(repoRoot, abs);
    if (EXEMPT_FILES.has(rel)) continue;
    const lines = (await readFile(abs, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (line.includes(RETIRED) && !RETIRED_CONTEXT.test(line)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `retired slug '${RETIRED}' found in live context:\n${offenders.join("\n")}`);
});

test("the current 8hats/marketplace slug is taught by every install surface", async () => {
  for (const rel of [
    "plugins/bios-implant/SETUP.md",
    "plugins/bios-implant/INSTALL.md",
    "docs/one-prompt-install.md",
    "plugins/bios-implant/skills/8hats-implant-install/SKILL.md",
  ]) {
    const body = await readFile(path.join(repoRoot, rel), "utf8");
    assert.ok(body.includes(CURRENT), `${rel} must teach ${CURRENT}`);
  }
});
