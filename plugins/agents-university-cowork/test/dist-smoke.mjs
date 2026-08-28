import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const source = new URL('../dist/cowork-mcp.mjs', import.meta.url);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-dist-'));
const target = path.join(dir, 'cowork-mcp.mjs'); await fs.copyFile(source, target);
await fs.access(target); assert.equal(await fs.stat(path.join(dir, 'node_modules')).then(() => true, () => false), false);
const child = spawn(process.execPath, [target], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: dir, OURS_STATE_DIR: path.join(dir, 'ours') } });
child.stdin.end(); const code = await new Promise((resolve) => child.on('exit', resolve));
assert.ok(code === 0 || code === null, `bundle exited ${code}`);
