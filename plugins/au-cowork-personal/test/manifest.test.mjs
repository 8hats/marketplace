import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

const read = async (p) => JSON.parse(await fs.readFile(new URL(p, import.meta.url), 'utf8'));
test('package, Claude, and Codex manifests agree', async () => {
  const [pkg, claude, codex] = await Promise.all([read('../package.json'), read('../.claude-plugin/plugin.json'), read('../.codex-plugin/plugin.json')]);
  assert.equal(claude.name, 'au-cowork-personal'); assert.equal(codex.name, claude.name); assert.equal(pkg.version, claude.version); assert.equal(codex.version, claude.version);
  assert.equal(pkg.dependencies['@ours.network/sdk'], '3.8.1-nightly.9');
  assert.deepEqual(Object.keys(claude.mcpServers), ['au-cowork']);
  assert.deepEqual(Object.keys((await read('../.mcp.json')).mcpServers), ['au-cowork']);
});

// The version the MCP server advertises to clients is a FOURTH location, and nothing tied it to
// package.json: bumping the three manifests and forgetting src/server.mjs left the suite green
// while every client was told the old version.
test('the advertised server version matches the package version', async () => {
  const pkg = await read('../package.json');
  const { VERSION } = await import('../src/server.mjs');
  assert.equal(VERSION, pkg.version);
});

test('the distributable carries exact pinned third-party license texts', async () => {
  const notice = await fs.readFile(new URL('../dist/THIRD_PARTY_LICENSES.txt', import.meta.url), 'utf8');
  const bundled = await read('../dist/BUNDLED_PACKAGES.json');
  assert.deepEqual(bundled, ['@modelcontextprotocol/sdk', '@ours.network/sdk', 'ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'zod', 'zod-to-json-schema']);
  for (const name of bundled) {
    const license = await fs.readFile(new URL(`../node_modules/${name}/LICENSE`, import.meta.url), 'utf8').catch(() => fs.readFile(new URL(`../node_modules/${name}/LICENSE.md`, import.meta.url), 'utf8'));
    // Compare with line endings normalised: git checks the committed notice out as CRLF on
    // Windows while npm delivers the package LICENSE with LF, so a raw includes() compares
    // encodings rather than licence texts.
    const lf = (value) => value.replace(/\r\n/g, '\n');
    assert.match(notice, new RegExp(`===== ${name.replace('/', '\\/')} =====`)); assert.ok(lf(notice).includes(lf(license).trim()));
  }
  const { stdout } = await exec('npm', ['pack', '--dry-run', '--json'], { cwd: new URL('..', import.meta.url) });
  const packed = JSON.parse(stdout)[0].files.map((row) => row.path); assert.ok(packed.includes('dist/THIRD_PARTY_LICENSES.txt')); assert.ok(packed.includes('dist/BUNDLED_PACKAGES.json'));
});
