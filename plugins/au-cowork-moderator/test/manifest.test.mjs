import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {CentralClient} from '../src/central-client.mjs';
import {createRuntime} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {centralTools} from '../src/central-tools.mjs';

const read = async (p) => JSON.parse(await fs.readFile(new URL(p, import.meta.url), 'utf8'));

test('package, Claude, and Codex manifests agree', async () => {
  const [pkg, claude, codex] = await Promise.all([read('../package.json'), read('../.claude-plugin/plugin.json'), read('../.codex-plugin/plugin.json')]);
  assert.equal(claude.name, 'au-cowork-moderator'); assert.equal(codex.name, claude.name);
  assert.equal(pkg.version, claude.version); assert.equal(codex.version, claude.version);
  assert.equal(pkg.dependencies['@ours.network/sdk'], undefined);
  assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'], '1.30.0');
});

test('the advertised server version matches the package version', async () => {
  const pkg = await read('../package.json');
  const { VERSION } = await import('../src/server.mjs');
  assert.equal(VERSION, pkg.version);
});

test('legacy supplied Moderator inputs are rejected before connecting',()=>{
 const previous=process.env.AC_MODERATOR_INPUTS_MODULE;
 try{process.env.AC_MODERATOR_INPUTS_MODULE='/unused/legacy-inputs.mjs';assert.throws(()=>new CentralClient(),{code:'legacy_configuration_rejected'});}
 finally{if(previous===undefined)delete process.env.AC_MODERATOR_INPUTS_MODULE;else process.env.AC_MODERATOR_INPUTS_MODULE=previous;}
});

test('default Moderator MCP exposes all Moderator tools without granting client authority',async()=>{
 const client=new CentralClient({fetchFn:async()=>{throw Error('unexpected network');}});
 const runtime=await createRuntime({client}),host=new Client({name:'moderator-contract-test',version:'1'});
 const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
 try{
  await runtime.server.connect(serverTransport);await host.connect(clientTransport);
  assert.equal(host.getServerVersion().name,'au-cowork-moderator');
  const names=(await host.listTools()).tools.map(tool=>tool.name);
  assert.deepEqual(names.filter(name=>name.startsWith('ac_')).sort(),centralTools(client,'moderator').map(tool=>tool.name).sort());
  assert.equal(names.includes('ac_join'),false);
  const denied=await host.callTool({name:'ac_review_publish',arguments:{round_id:'round'}});
  assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).error.code,'not_connected');
 }finally{await host.close();await runtime.shutdown();}
});
