#!/usr/bin/env node
// Exact built artifacts + real adapter seam over trusted loopback HTTPS.
// The proof backend is simulated: application SQL/name/role/browser integration is separate.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,cp,copyFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {proofBackend} from './invitation-link-fixtures/proof-backend.mjs';

const exec=promisify(execFile),repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!/^(AC_|OURS_|AU_OURS_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_USE_ENV_PROXY$|https?_proxy$|all_proxy$)/i.test(key)));
const body=result=>result.structuredContent??JSON.parse(result.content[0].text);

async function worker(root,origin){
 const watchdog=setTimeout(()=>{console.error('FAIL: bounded invitation worker timeout');process.exit(2);},90000);watchdog.unref();
 const require=createRequire(join(repo,'plugins/au-cowork-personal/package.json'));
 const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
 const expected=JSON.parse(await readFile(join(root,'identity.json'),'utf8'));
 const stats=async()=>{const response=await fetch(origin+'/__proof');assert.equal(response.status,200);return (await response.json()).data;};
 let serial=0,successes=0,negativeCases=0,restarts=0;
 for(const seam of ['personal-stdio','moderator-stdio','personal-harness']){
  const profile=seam.startsWith('moderator')?'moderator':'personal',version=expected[profile].version;
  const state=join(root,seam+'-state');let api;
  const open=async()=>{
   if(seam.endsWith('stdio')){
    const client=new Client({name:'invitation-proof',version:'1'});
    const transport=new StdioClientTransport({command:process.execPath,args:[join(root,profile+'-standalone/cowork-mcp.mjs')],cwd:root,env:{...cleanEnv(),NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,AC_COWORK_HOME:state,AC_COWORK_URL:origin},stderr:'pipe'});
    // Drain diagnostics; synthetic token/credential values are never printed.
    transport.stderr?.on('data',()=>{});
    await client.connect(transport,{timeout:5000});
    assert.equal(client.getServerVersion().version,version);assert.equal(client.getServerVersion().name,'au-cowork-'+profile);
    const listing=await client.listTools();for(const name of ['enter_room','connect_to_room','get_watch_status','ac_read'])assert.ok(listing.tools.some(tool=>tool.name===name));
    return {call:(name,args={})=>client.callTool({name,arguments:args},undefined,{timeout:5000}),close:()=>client.close()};
   }
   const {createCoordinator}=await import(pathToFileURL(join(root,'personal-harness/index.js')).href);
   const tools=new Map(),agent={id:'invitation-proof',async steer(){}};
   agent.ctx={get:name=>name==='tools'?{register(tool){assert.ok(!tools.has(tool.name));tools.set(tool.name,tool);return ()=>tools.delete(tool.name);}}:undefined};
   const ctx={agents:{get:id=>id===agent.id?agent:undefined,withoutInitiator:fn=>fn()}};
   const coordinator=createCoordinator(ctx,{stateRoot:state,origin});
   await coordinator.attach(agent);
   for(const name of ['enter_room','connect_to_room','get_watch_status','ac_read'])assert.ok(tools.has('mcp__au-cowork__'+name));
   return {async call(name,args={}){
    try{return await tools.get('mcp__au-cowork__'+name).execute(args,{signal:AbortSignal.timeout(5000)});}
    catch(error){if(error.name!=='CoworkToolError')throw error;return {isError:true,structuredContent:JSON.parse(error.message)};}
   },close:()=>coordinator.dispose()};
  };
  const ok=async(name,args={})=>{const result=await api.call(name,args);assert.notEqual(result.isError,true,seam+' '+name+' failed');return body(result);};
  const checkIdentity=async()=>{const result=await ok('get_watch_status');assert.equal(result.data.version,version);if(seam.endsWith('harness'))assert.equal(result.host_watch.session_id,'invitation-proof');};
  api=await open();
  try{
   await checkIdentity();let lastId;
   for(const tool of ['enter_room','connect_to_room'])for(const shape of ['canonical','instruction','name','encoded']){
    const token=String(++serial).padStart(43,'a'),canonical=origin+'/#/agent-invite/'+token;
    const link=shape==='canonical'?canonical:shape==='encoded'?origin+'/agent-instructions#invite='+encodeURIComponent(canonical)+'&name=Wrong+URL+name':origin+'/agent-instructions#token='+token+(shape==='name'?'&name=Wrong+URL+name':'');
    const before=await stats(),submitted=tool==='enter_room'?'Explicit argument name':'Cowork agent';
    const connected=await ok(tool,{invite:link,...(tool==='enter_room'?{as_agent:submitted}:{})});
    assert.equal(connected.data.as_agent,'Backend chosen name');lastId=connected.data.connection_id;assert.match(lastId,/^[a-f0-9-]{36}$/);
    const after=await stats();assert.equal(after.exchangeCount,before.exchangeCount+1);assert.equal(after.membershipCount,before.membershipCount+1);
    assert.deepEqual(after.records.at(-1),{token,display_name:submitted});assert.deepEqual(after.errors,[]);
    for(const kind of ['context','capabilities'])assert.equal((await ok('ac_read',{kind})).data.proof,kind);
    assert.equal((await ok('get_room_status')).data.room.id,'proof-room');
    await ok('disconnect_from_room');
    const resumed=await ok('connect_to_room',{connection_id:lastId});assert.equal(resumed.data.connection_id,lastId);assert.equal(resumed.data.as_agent,'Backend chosen name');
    assert.equal((await stats()).exchangeCount,after.exchangeCount);assert.equal((await stats()).membershipCount,after.membershipCount);
    await ok('disconnect_from_room');successes++;
   }
   // A new process/coordinator must load the saved identity rather than consume an invite.
   const beforeRestart=await stats();await api.close();api=await open();await checkIdentity();
   assert.equal((await ok('connect_to_room',{connection_id:lastId})).data.connection_id,lastId);
   assert.equal((await ok('ac_read',{kind:'context'})).data.proof,'context');await ok('disconnect_from_room');
   assert.equal((await stats()).exchangeCount,beforeRestart.exchangeCount);assert.equal((await stats()).membershipCount,beforeRestart.membershipCount);restarts++;
   for(const tool of ['enter_room','connect_to_room']){
    const before=await stats();const result=await api.call(tool,{invite:origin+'/agent-instructions#token=short',...(tool==='enter_room'?{as_agent:'Explicit'}:{})});
    assert.equal(result.isError,true);assert.equal(body(result).error.code,'invalid_invitation');assert.equal(body(result).error.retryable,false);assert.match(body(result).error.message,/Unsupported invitation URL/);assert.equal((await stats()).exchangeCount,before.exchangeCount);negativeCases++;
    for(const [mode,char] of [['lost','L'],['malformed','M'],['expired','E']]){
     const before=await stats();const result=await api.call(tool,{invite:origin+'/agent-instructions#token='+char.repeat(43),...(tool==='enter_room'?{as_agent:'Explicit'}:{})});
     assert.equal(result.isError,true);const error=body(result).error;assert.equal(error.retryable,false);
     if(mode==='expired')assert.equal(error.code,'expired');else assert.match(error.message,/Do not retry.*inspect membership/);
     const after=await stats();assert.equal(after.exchangeCount,before.exchangeCount+1);assert.deepEqual(after.errors,[]);
     assert.equal((await ok('get_watch_status')).data.watch_enabled,false);negativeCases++;
    }
   }
  }finally{await api?.close();}
 }
 const final=await stats();assert.deepEqual(final.errors,[]);
 console.log(JSON.stringify({result:'PASS',successJourneys:successes,negativeCases,restartedSavedIdentityChecks:restarts,exchangeAttempts:final.exchangeCount,simulation:'trusted loopback HTTPS transport fixture, not application SQL/roles/browser integration'}));
 clearTimeout(watchdog);
}

async function main(){
 assert.ok(Number(process.versions.node.split('.')[0])>=22,'Node22+ required');assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0','Do not disable TLS verification');
 const root=await mkdtemp(join(tmpdir(),'cowork-invitation-e2e-'));let backend;
 try{
  const identity={};
  for(const profile of ['personal','moderator']){
   const base=join(repo,'plugins/au-cowork-'+profile),meta=JSON.parse(await readFile(join(base,'package.json'),'utf8'));
   const runtime=await readFile(join(base,'dist/cowork-mcp.mjs'));identity[profile]={package:meta.name,version:meta.version,sha256:sha(runtime)};
   await mkdir(join(root,profile+'-standalone'));await copyFile(join(base,'dist/cowork-mcp.mjs'),join(root,profile+'-standalone/cowork-mcp.mjs'));
   if(profile==='personal'){
    assert.equal(sha(await readFile(join(base,'harness/dist/cowork-mcp.mjs'))),identity.personal.sha256,'Harness/top-level runtime mismatch; rebuild first');
    const host=JSON.parse(await readFile(join(base,'harness/package.json'),'utf8'));assert.equal(host.version,meta.version);
    await cp(join(base,'harness'),join(root,'personal-harness'),{recursive:true});
   }
  }
  await writeFile(join(root,'identity.json'),JSON.stringify(identity));
  backend=await proofBackend(root);
  const {stdout}=await exec(process.execPath,[fileURLToPath(import.meta.url),'--worker',root,backend.origin],{cwd:root,env:{...cleanEnv(),NODE_EXTRA_CA_CERTS:backend.ca},timeout:110000,maxBuffer:1024*1024,killSignal:'SIGKILL'});
  assert.deepEqual(backend.snapshot().errors,[]);
  // Explicitly reject concurrent rebuilds/metadata changes so the proof never mixes artifacts.
  for(const profile of ['personal','moderator']){
   const base=join(repo,'plugins/au-cowork-'+profile);assert.equal(sha(await readFile(join(base,'dist/cowork-mcp.mjs'))),identity[profile].sha256,'Artifact changed while checking; rerun after parent build');
   assert.equal(JSON.parse(await readFile(join(base,'package.json'),'utf8')).version,identity[profile].version,'Metadata changed while checking; rerun');
   if(profile==='personal')assert.equal(sha(await readFile(join(base,'harness/dist/cowork-mcp.mjs'))),identity.personal.sha256,'Harness artifact changed while checking; rerun');
  }
  console.log(stdout.trim());console.log(JSON.stringify({observedArtifacts:identity,personalHarnessRuntimeSha256:identity.personal.sha256,scope:'existing isolated copies only; no install, build, source changes or production traffic'}));
 }finally{await backend?.close();await rm(root,{recursive:true,force:true});}
}
try{if(process.argv[2]==='--worker')await worker(process.argv[3],process.argv[4]);else await main();}
catch(error){console.error('FAIL: invitation-specific exact packaged check');console.error(error.stderr??error.stack??error.message);process.exitCode=1;}
