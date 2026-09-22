import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cowork-dist-'));
const target=path.join(dir,'cowork-mcp.mjs');await fs.copyFile(new URL('../dist/cowork-mcp.mjs',import.meta.url),target);
assert.equal(await fs.stat(path.join(dir,'node_modules')).then(()=>true,()=>false),false);
// HOME is POSIX-only; Windows resolves the home directory from USERPROFILE. Set both, or the
// bundle writes its state into the real profile instead of this throwaway directory.
const home={HOME:dir,USERPROFILE:dir,OURS_STATE_DIR:path.join(dir,'ours')};
const transport=new StdioClientTransport({command:process.execPath,args:[target],env:{...process.env,...home},stderr:'pipe'});
const client=new Client({name:'standalone-bundle-test',version:'1'});
// Keep the child's stderr. Without it a bundle that dies at startup surfaces only
// "MCP error -32000: Connection closed", naming the symptom and hiding the cause.
let stderr='';
const collect=()=>{const s=transport.stderr;if(s&&!s.readableEnded)s.on('data',chunk=>{stderr+=chunk;});};
try{
 const connected=client.connect(transport);collect();await connected;
 const list=await client.listTools();assert.equal(list.tools.length,22);
 const result=await client.callTool({name:'ac_read',arguments:{kind:'room'}});assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'not_connected');
}catch(error){
 const drained=stderr||(transport.stderr?.read?.()??'');
 error.message=`${error.message}\n--- bundle stderr ---\n${drained||'(none captured)'}`;
 throw error;
}finally{await client.close().catch(()=>{});await transport.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});}
