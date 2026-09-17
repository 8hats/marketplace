import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

for (const name of ['agents-university-cowork', 'agents-cowork-moderator']) {
  test(`${name} declares independently executable Harness MCP compatibility`, async () => {
    const root = resolve('plugins', name)
    const manifest = JSON.parse(await readFile(resolve(root, 'harness.json'), 'utf8'))
    assert.deepEqual(manifest, { schemaVersion: 1, mcp: '.mcp.json' })
    const mcp = JSON.parse(await readFile(resolve(root, manifest.mcp), 'utf8'))
    const native = JSON.parse(await readFile(resolve(root, '.codex-plugin/plugin.json'), 'utf8'))
    assert.equal(native.name, name)
    for (const server of Object.values(mcp.mcpServers)) {
      assert.equal(server.type, 'stdio')
      assert.equal(server.command, 'node')
      assert.equal(server.cwd, '${CODEX_PLUGIN_ROOT}')
      assert.equal(server.args.length, 1)
      assert.equal((await stat(resolve(root, server.args[0]))).isFile(), true)
    }
  })
}
