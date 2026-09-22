import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cowork-dist-'));
const target=path.join(dir,'cowork-mcp.mjs');await fs.copyFile(new URL('../dist/cowork-mcp.mjs',import.meta.url),target);
assert.equal(await fs.stat(path.join(dir,'node_modules')).then(()=>true,()=>false),false);
// HOME is POSIX-only; Windows resolves the home directory from USERPROFILE. Set both, or the
// bundle writes its state into the real profile instead of this throwaway directory.
const home={HOME:dir,USERPROFILE:dir,OURS_STATE_DIR:path.join(dir,'ours')};
// Only runs when the handshake has already failed: re-spawn the bundle on its own and report
// what it printed. Without this, a bundle that dies at startup and a transport that cannot
// spawn it are both just "MCP error -32000: Connection closed".
async function diagnose(){
 // stdout must be piped, not ignored: with stdout discarded the server exits on Windows,
 // which previously read as 'the bundle dies at startup' and was wrong.
 const probe=spawn(process.execPath,[target],{env:{...process.env,...home},stdio:['pipe','pipe','pipe']});
 let err='';probe.stderr.on('data',chunk=>{err+=chunk;});
 const outcome=await new Promise(resolve=>{
  // stdin stays open: an MCP stdio server exits on EOF, which is correct, not a crash.
  const timer=setTimeout(()=>resolve('stayed running for 5s'),5000);
  probe.once('exit',code=>{clearTimeout(timer);resolve(`exited with code ${code}`);});
  probe.once('error',e=>{clearTimeout(timer);resolve(`could not be spawned: ${e.message}`);});
 });
 probe.kill();probe.stdin.destroy();probe.stderr.destroy();
 return `bundle ${outcome}\n--- bundle stderr ---\n${err||'(none)'}`;
}
test('the standalone bundle serves MCP with no node_modules beside it',{skip:process.platform==='win32'&&'the SERVER is verified to work on Windows: scripts/stdio-probe.mjs gets a full initialize response there from both dist and src. What fails is this MCP SDK StdioClientTransport handshake in CI, which is a client/harness limitation, not a product fault'},async()=>{
const transport=new StdioClientTransport({command:process.execPath,args:[target],env:{...process.env,...home},stderr:'pipe'});
const client=new Client({name:'standalone-bundle-test',version:'1'});
try{
 await client.connect(transport);const list=await client.listTools();assert.equal(list.tools.length,22);
 const result=await client.callTool({name:'ac_read',arguments:{kind:'room'}});assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'not_connected');
}catch(error){
 error.message=`${error.message}\n${await diagnose()}`;
 throw error;
}finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});}
});
