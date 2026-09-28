import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {inspectWindowsState,INSPECTION_TIMEOUT_MS} from '../src/windows-inspection.mjs';

function fixture(t,directory=true){
 t.mock.timers.enable({apis:['setTimeout']});
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();
 child.stdin.end=()=>{};let kills=0,starts=0;
 child.kill=()=>{kills++;};
 const promise=inspectWindowsState('powershell','script','fixture',directory,()=>{starts++;return child;});
 return {child,promise,kills:()=>kills,starts:()=>starts};
}

test('cold inspection may exceed ten seconds and waits for stdout after exit',async t=>{
 const f=fixture(t);let settled=false;f.promise.then(()=>{settled=true;});
 t.mock.timers.tick(11000);await Promise.resolve();assert.equal(settled,false);assert.equal(f.kills(),0);
 f.child.emit('exit',0);f.child.stdout.emit('data',Buffer.from('pri'));f.child.stdout.emit('data',Buffer.from('vate'));
 f.child.emit('close',0);await f.promise;t.mock.timers.tick(INSPECTION_TIMEOUT_MS);assert.equal(f.kills(),0);
});

test('inspection deadline rejects and kills once without retries or late success',async t=>{
 const f=fixture(t);const rejected=assert.rejects(f.promise,{code:'state_inspection_failed'});
 t.mock.timers.tick(INSPECTION_TIMEOUT_MS-1);assert.equal(f.kills(),0);
 t.mock.timers.tick(1);await rejected;assert.equal(f.kills(),1);assert.equal(f.starts(),1);
 f.child.stdout.emit('data','private');f.child.emit('close',0);
});

for(const directory of [true,false])test(`explicit unsafe ${directory?'directory':'file'} stays rejected`,async t=>{
 const f=fixture(t,directory);const rejected=assert.rejects(f.promise,{code:directory?'unsafe_state_directory':'unsafe_connection_state'});
 f.child.stdout.emit('data','unsafe');f.child.emit('close',1);await rejected;
 t.mock.timers.tick(INSPECTION_TIMEOUT_MS);assert.equal(f.starts(),1);assert.equal(f.kills(),0);
});

for(const [label,output,exit] of [['inspection error','inspection_failed',2],['empty','',0],['truncated','priv',0],['mismatched status','private',1],['signal','private',null]])test(`${label} is an inspection failure`,async t=>{
 const f=fixture(t);const rejected=assert.rejects(f.promise,{code:'state_inspection_failed'});
 f.child.stdout.emit('data',output);f.child.emit('close',exit);await rejected;
});

test('spawn error is an inspection failure',async t=>{
 const f=fixture(t);const rejected=assert.rejects(f.promise,{code:'state_inspection_failed'});
 f.child.emit('error',new Error('spawn failed'));await rejected;
});

test('excessive output fails closed and kills the helper',async t=>{
 const f=fixture(t);const rejected=assert.rejects(f.promise,{code:'state_inspection_failed'});
 f.child.stdout.emit('data','x'.repeat(129));await rejected;assert.equal(f.kills(),1);
});


test('failed root inspection blocks exchange and credential writes with actionable MCP guidance',async()=>{
 const {CentralClient}=await import('../src/central-client.mjs');
 const {createRuntime}=await import('../src/server.mjs');
 let exchanges=0,writes=0;
 const client=new CentralClient({store:{init:async()=>{throw Object.assign(Error('inspection'),{code:'state_inspection_failed'});},save:async()=>{writes++;}},fetchFn:async()=>{exchanges++;throw Error('unexpected exchange');}});
 const handlers=new Map();
 const runtime=await createRuntime({client,injectedServer:{registerTool:(name,descriptor,handler)=>handlers.set(name,handler)}});
 try {
  const result=await handlers.get('connect_to_room')({invite:'https://cowork.example/#/agent-invite/'+'a'.repeat(43)});
  assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'state_inspection_failed');
  assert.equal(result.structuredContent.error.retryable,false);
  assert.match(result.structuredContent.error.message,/PowerShell/);
  assert.match(result.structuredContent.error.message,/Do not change ACLs/);
  assert.equal(exchanges,0);assert.equal(writes,0);assert.equal(client.row,null);
 }finally{await runtime.shutdown();}
});
