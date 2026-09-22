import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = async (p) => JSON.parse(await fs.readFile(new URL(p, import.meta.url), 'utf8'));

// The moderator shipped with no manifest test at all, so its three version locations could
// desync silently. It bundles au-cowork-personal's sources, so its SDK pin must match too.
test('package, Claude, and Codex manifests agree', async () => {
  const [pkg, claude, codex] = await Promise.all([read('../package.json'), read('../.claude-plugin/plugin.json'), read('../.codex-plugin/plugin.json')]);
  assert.equal(claude.name, 'au-cowork-moderator'); assert.equal(codex.name, claude.name);
  assert.equal(pkg.version, claude.version); assert.equal(codex.version, claude.version);
  assert.equal(pkg.dependencies['@ours.network/sdk'], '3.8.1-nightly.9');
});

test('the advertised server version matches the package version', async () => {
  const pkg = await read('../package.json');
  const { VERSION } = await import('../src/server.mjs');
  assert.equal(VERSION, pkg.version);
});
