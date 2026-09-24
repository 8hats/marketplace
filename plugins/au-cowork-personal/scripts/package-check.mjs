import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=await mkdtemp(join(tmpdir(),'cowork-package-'));
let client;
try{
 const packed=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',root],{cwd:resolve('.'),encoding:'utf8'}));
 execFileSync('tar',['-xzf',join(root,packed[0].filename),'-C',root]);
 execFileSync('npm',['install','--ignore-scripts','--omit=dev','--no-audit','--no-fund'],{cwd:join(root,'package'),stdio:'pipe'});
 const standalone=join(root,'standalone');await mkdir(standalone,{mode:0o700});
 await copyFile(join(root,'package/dist/cowork-mcp.mjs'),join(standalone,'cowork-mcp.mjs'));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!key.startsWith('OURS_')&&!key.startsWith('AC_')));
 env.AC_COWORK_HOME=join(root,'private-state');
 client=new Client({name:'isolated-package-check',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[join(standalone,'cowork-mcp.mjs')],cwd:standalone,env,stderr:'pipe'}));
 const {tools}=await client.listTools();assert.ok(tools.some(tool=>tool.name==='ac_submit_result'));assert.ok(tools.some(tool=>tool.name==='wait_for_room_event'));
 const result=await client.callTool({name:'list_rooms',arguments:{}});assert.equal(result.isError,undefined);
 assert.deepEqual(JSON.parse(result.content[0].text).data.rooms,[]);
 const disconnected=await client.callTool({name:'get_room_status',arguments:{}});assert.equal(disconnected.isError,true);
 assert.equal(JSON.parse(disconnected.content[0].text).error.code,'not_connected');
 console.log('PASS: packed install and standalone stdio MCP initialize/catalogue/private state checks');
}finally{await client?.close();await rm(root,{recursive:true,force:true});}
