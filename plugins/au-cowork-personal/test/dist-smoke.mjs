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
test('the standalone bundle serves MCP with no node_modules beside it',{skip:process.platform==='win32'&&'KNOWN WINDOWS DEFECT, not a harness limitation: run from a directory with no node_modules beside it -- which is how the plugin is installed -- the bundle exits 0 immediately instead of serving. From inside the repo it responds. Linux does both. Reproduce: node scripts/stdio-probe.mjs dist/cowork-mcp.mjs --isolate'},async()=>{
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

// The main-module guard decides whether the server connects its transport at all. It used to
// build a file URL by hand (`new URL('file://'+process.argv[1])`), so any path the URL parser
// reads specially -- '#' becomes a fragment, '?' a query -- made the comparison fail. The module
// then loaded, connected nothing and exited 0 with an empty stderr: no crash, no output, no
// server. The moderator plugin already used pathToFileURL; this pins the personal one.
test('the bundle still serves from a path the URL parser would mangle',async()=>{
 for(const awkward of ['hash#dir','query?dir','space dir']){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'cowork-path-'));
  const nest=path.join(base,awkward);
  try{
   await fs.mkdir(nest,{recursive:true});
   const entry=path.join(nest,'cowork-mcp.mjs');
   await fs.copyFile(new URL('../dist/cowork-mcp.mjs',import.meta.url),entry);
   const child=spawn(process.execPath,[entry],{env:{...process.env,HOME:base,USERPROFILE:base},stdio:['pipe','pipe','pipe']});
   let out='';child.stdout.on('data',c=>{out+=c;});
   let exited=null;child.once('exit',c=>{exited=c;});
   await new Promise(r=>setTimeout(r,400));
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'path-test',version:'1'}}})+'\n');
   const deadline=Date.now()+8000;
   while(Date.now()<deadline&&exited===null&&!out.includes('"id":1'))await new Promise(r=>setTimeout(r,50));
   child.kill();child.stdin.destroy();
   assert.ok(out.includes('"id":1'),`the bundle did not serve from a path containing ${JSON.stringify(awkward)} (exit ${exited}); the main-module guard likely failed to match`);
  }finally{await fs.rm(base,{recursive:true,force:true});}
 }
});
