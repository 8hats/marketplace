import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);

const read = async (p) => JSON.parse(await fs.readFile(new URL(p, import.meta.url), 'utf8'));
test('package, Claude, and Codex manifests agree', async () => {
  const [pkg, claude, codex] = await Promise.all([read('../package.json'), read('../.claude-plugin/plugin.json'), read('../.codex-plugin/plugin.json')]);
  assert.equal(claude.name, 'agents-university-cowork'); assert.equal(codex.name, claude.name); assert.equal(pkg.version, claude.version); assert.equal(codex.version, claude.version);
  assert.equal(pkg.dependencies['@ours.network/sdk'], '3.6.0');
});

test('the distributable carries exact pinned third-party license texts', async () => {
  const notice = await fs.readFile(new URL('../dist/THIRD_PARTY_LICENSES.txt', import.meta.url), 'utf8');
  const bundled = await read('../dist/BUNDLED_PACKAGES.json');
  assert.deepEqual(bundled, ['@modelcontextprotocol/sdk', '@ours.network/sdk', 'ajv', 'ajv-formats', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'zod', 'zod-to-json-schema']);
  for (const name of bundled) {
    const license = await fs.readFile(new URL(`../node_modules/${name}/LICENSE`, import.meta.url), 'utf8').catch(() => fs.readFile(new URL(`../node_modules/${name}/LICENSE.md`, import.meta.url), 'utf8'));
    assert.match(notice, new RegExp(`===== ${name.replace('/', '\\/')} =====`)); assert.ok(notice.includes(license.trim()));
  }
  const { stdout } = await exec('npm', ['pack', '--dry-run', '--json'], { cwd: new URL('..', import.meta.url) });
  const packed = JSON.parse(stdout)[0].files.map((row) => row.path); assert.ok(packed.includes('dist/THIRD_PARTY_LICENSES.txt')); assert.ok(packed.includes('dist/BUNDLED_PACKAGES.json'));
});
