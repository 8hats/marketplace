import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cowork-dist-'));
const target=path.join(dir,'cowork-mcp.mjs');await fs.copyFile(new URL('../dist/cowork-mcp.mjs',import.meta.url),target);
assert.equal(await fs.stat(path.join(dir,'node_modules')).then(()=>true,()=>false),false);
const transport=new StdioClientTransport({command:process.execPath,args:[target],env:{...process.env,HOME:dir,OURS_STATE_DIR:path.join(dir,'ours')},stderr:'pipe'});
const client=new Client({name:'standalone-bundle-test',version:'1'});
try{
 await client.connect(transport);const list=await client.listTools();assert.equal(list.tools.length,19);
 const result=await client.callTool({name:'ac_read',arguments:{kind:'room'}});assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).code,'not_connected');
}finally{await client.close();await transport.close();await fs.rm(dir,{recursive:true,force:true});}
