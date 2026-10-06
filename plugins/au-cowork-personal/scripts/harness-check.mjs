// Offline integration against an installed Harness's exact Cordis registries.
// Usage: node scripts/harness-check.mjs /absolute/harness/deployment
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createCoordinator} from '../harness/index.js';
const deployment=process.argv[2];
if(!deployment||!path.isAbsolute(deployment))throw Error('Absolute Harness deployment path required');
const require=createRequire(path.join(deployment,'packages/core/scope/package.json'));
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const load=relative=>import(pathToFileURL(path.join(deployment,relative)).href);
const {createScope}=await load('packages/core/scope/lib/index.js');
const {default:Tools}=await load('packages/core/tools/lib/index.js');
const {default:SystemPrompt}=await load('packages/core/system-prompt/lib/index.js');
const root=await fs.mkdtemp(path.join(tmpdir(),'cowork-harness-check-'));
const ctx=new Context(),live=new Map();
ctx.provide('agents',{get:id=>live.get(id),withoutInitiator:fn=>fn()});
const prompt=ctx.plugin(SystemPrompt);await prompt;
const tools=ctx.plugin(Tools);await tools;
const scopes=[],coordinator=createCoordinator(ctx,{stateRoot:root});
try{
 for(const id of ['chat','fork']){
  const agent={id,messages:[],steer(message){this.messages.push(message);}};
  const scope=createScope(ctx,agent);scopes.push(scope);agent.ctx=scope.ctx;live.set(id,agent);
  await coordinator.attach(agent);
 }
 assert.equal(ctx.tools.get('mcp__au-cowork__get_watch_status'),undefined,'no global tool registration');
 const [a,b]=[...live.values()];
 assert.notEqual(ctx.tools.get('mcp__au-cowork__get_watch_status',a),ctx.tools.get('mcp__au-cowork__get_watch_status',b));
 for(const agent of live.values()){
  const result=await ctx.tools.execute({agent,name:'mcp__au-cowork__get_watch_status',arguments:{},callId:'offline-'+agent.id,signal:AbortSignal.timeout(5000)});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.equal(result.value.structuredContent.host_watch.session_id,agent.id);
  assert.equal(result.value.structuredContent.data.watch_enabled,false);
 }
 await coordinator.dispose();
 for(const agent of live.values())assert.equal(ctx.tools.get('mcp__au-cowork__get_watch_status',agent),undefined);
 console.log('PASS: exact Harness Agent contexts isolate tools and dispose cleanly without peer imports or network access');
}finally{
 await coordinator.dispose();for(const scope of scopes)await scope.dispose();
 await tools.dispose();await prompt.dispose();await fs.rm(root,{recursive:true,force:true});
}
