// Decides one question: does an MCP stdio server stay alive and answer `initialize` on this
// platform? Run it against both dist/ and src/ to separate "the bundle is broken" from
// "the server is broken". Diagnostic only -- it is not part of any suite and asserts nothing;
// it prints a verdict and exits 0 so a CI step can report every target in one run.
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// --ignore-stdout / --no-frame reproduce the two ways the earlier diagnostic differed from this
// probe, so the cause of its misleading "exited with code 0" can be isolated to one of them
// rather than attributed to whichever is convenient.
const args=process.argv.slice(2);
const target=args.find(a=>!a.startsWith('--'));
const ignoreStdout=args.includes('--ignore-stdout');
const noFrame=args.includes('--no-frame');
if(!target){console.error('usage: stdio-probe.mjs <entry.mjs> [--ignore-stdout] [--no-frame]');process.exit(2);}

const home=await fs.mkdtemp(path.join(os.tmpdir(),'stdio-probe-'));
// HOME is POSIX-only; Windows reads USERPROFILE. Set both so the probe never touches real state.
const env={...process.env,HOME:home,USERPROFILE:home,OURS_STATE_DIR:path.join(home,'ours')};
const child=spawn(process.execPath,[target],{env,stdio:['pipe',ignoreStdout?'ignore':'pipe','pipe']});

let out='',err='',exit=null;
child.stdout?.on('data',c=>{out+=c;});
child.stderr.on('data',c=>{err+=c;});
child.once('exit',code=>{exit=code;});
child.once('error',e=>{err+=`spawn error: ${e.message}`;exit='spawn-failed';});

// Newline-delimited JSON-RPC, which is what the MCP stdio transport speaks.
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'stdio-probe',version:'1'}}};
await new Promise(r=>setTimeout(r,500)); // let the server register its stdin reader first
const wroteAt=exit===null;
if(wroteAt&&!noFrame)child.stdin.write(JSON.stringify(initialize)+'\n');

const deadline=Date.now()+10_000;
while(Date.now()<deadline&&exit===null&&!out.includes('"id":1'))await new Promise(r=>setTimeout(r,100));

const responded=out.includes('"id":1');
const mode=`stdout=${ignoreStdout?'ignore':'pipe'} frame=${noFrame?'no':'yes'}`;
const verdict=responded?'RESPONDED to initialize -- the server works on this platform'
 :exit!==null?`EXITED (code ${exit}) -- did not stay alive`
 :ignoreStdout||noFrame?'STAYED ALIVE (no reply expected in this mode)'
 :'SILENT -- stayed alive but never answered initialize';

console.log(`target   : ${target}`);
console.log(`mode     : ${mode}`);
console.log(`platform : ${process.platform} ${process.arch} node ${process.versions.node}`);
console.log(`alive when the frame was written: ${wroteAt}`);
console.log(`verdict  : ${verdict}`);
console.log(`stdout   : ${out.trim().slice(0,400)||'(none)'}`);
console.log(`stderr   : ${err.trim().slice(0,800)||'(none)'}`);
child.kill();child.stdin.destroy();
await fs.rm(home,{recursive:true,force:true});
