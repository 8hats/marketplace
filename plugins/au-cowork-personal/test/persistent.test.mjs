import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {sessionRegistry} from '../src/session-registries.mjs';
import {ConnectionRegistry} from '../src/connections.mjs';
import {CoworkSession} from '../src/session.mjs';
import {createRuntime as personal} from '../src/server.mjs';
import {createRuntime as moderator} from '../../au-cowork-moderator/src/server.mjs';
const room='A'.repeat(64),legacy={init:async()=>{},list:async()=>[],get:async()=>null};
function daemon(){
 const identities=new Map();let creates=0,redeems=0,releases=0;
 return {identities,counts:()=>({creates,redeems,releases}),attach:async({leaseToken})=>{
  let current;return {close:async()=>{},
   createIdentity:async({name})=>{creates++;assert.equal(identities.has(name),false);current={name,cid:createHash('sha256').update(name).digest('hex').toUpperCase(),lease:leaseToken,contacts:[]};identities.set(name,current);},
   chooseIdentity:async({name,force})=>{assert.equal(force,false);const row=identities.get(name);if(!row)throw Object.assign(Error('absent'),{code:'NO_SUCH_IDENTITY'});if(row.lease&&row.lease!==leaseToken)throw Object.assign(Error('busy'),{code:'BOUND_ELSEWHERE'});current=row;row.lease=leaseToken;},
   currentIdentity:async()=>({name:current.name,cid:current.cid}),
   listIdentities:async()=>[...identities.values()].map(row=>({...row,session:row.lease===leaseToken?'mine':row.lease?'other-live':null})),
   addContact:async({invite})=>{redeems++;if(invite==='uncertain')throw Error('unknown');current.contacts=[{container_id:room}];return {cid:room,display:'Same room'};},listContacts:async()=>({contacts:current.contacts}),
   releaseLease:async()=>{releases++;if(current?.lease===leaseToken)current.lease=null;},
   closeTemporaryIdentityOp:async()=>{throw Error('must never close persistent identity');},
   listIncomingMessages:async()=>[],listIncomingFiles:async()=>[],watchNotifications:async function*(_name,{signal}){await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));},
   getMessages:async()=>({messages:[],command_results:[],remaining:0})
  };
 }};
}
async function open(factory,stateDir,network,remote=false){
 const session=new CoworkSession({resolve:()=>({expectStateDir:stateDir}),attach:network.attach,...remote?{remote:{url:'https://remote.example/gate'},attachRemoteFn:(_config,args)=>network.attach(args)}:{}});
 const connections=remote?sessionRegistry(session,ConnectionRegistry,['list','get','reserve','update'],{home:stateDir}):new ConnectionRegistry(stateDir);
 const runtime=await factory({session,registry:legacy,connections}),host=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await(runtime.server.server??runtime.server).connect(a);await host.connect(b);
 return {session,call:async(name,args={})=>JSON.parse((await host.callTool({name,arguments:args})).content[0].text),close:async()=>{await host.close();await runtime.shutdown();}};
}
for(const [profile,factory] of [['personal',personal],['moderator',moderator]])test(`${profile} cold session reconnect preserves identity CID and room without another redemption`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'au-persist-')),network=daemon();let a,b;
 try{a=await open(factory,dir,network);const connected=(await a.call('connect_to_room',{invite:'first'})).data;assert.equal(connected.identity_lifetime,'persistent');assert.ok(connected.connection_id);await a.close();a=null;
  b=await open(factory,dir,network);const listed=(await b.call('list_rooms')).data.rooms;assert.equal(listed.length,1);assert.equal(listed[0].connection_id,connected.connection_id);
  const resumed=(await b.call('connect_to_room',{connection_id:connected.connection_id})).data;assert.equal(resumed.agent_cid,connected.agent_cid);assert.equal(resumed.room_cid,room);assert.equal(resumed.bootstrap.status,'unchecked');assert.deepEqual(network.counts(),{creates:1,redeems:1,releases:1});
  await b.call('disconnect_from_room');const duplicate=await b.call('connect_to_room',{invite:'first'});assert.equal(duplicate.error.code,'invite_already_attempted');assert.equal(network.counts().redeems,1);assert.equal(network.identities.size,1);
 }finally{await a?.close();await b?.close();await rm(dir,{recursive:true,force:true});}
});
test('two Personal agents in one folder require exact selection and reject occupied identity without force',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'au-two-')),network=daemon();let a,b,c;
 try{a=await open(personal,dir,network);b=await open(personal,dir,network);c=await open(personal,dir,network);
  const first=(await a.call('connect_to_room',{invite:'a'})).data,second=(await b.call('connect_to_room',{invite:'b'})).data;assert.notEqual(first.agent_cid,second.agent_cid);assert.notEqual(first.connection_id,second.connection_id);
  assert.equal((await c.call('connect_to_room',{room_name:'Same room'})).error.code,'connection_selection_required');
  assert.equal((await c.call('connect_to_room',{connection_id:first.connection_id})).error.code,'identity_in_use');assert.equal(a.session.bound.identity_cid,first.agent_cid);
  await a.close();a=null;assert.equal((await c.call('connect_to_room',{connection_id:first.connection_id})).data.agent_cid,first.agent_cid);assert.equal(b.session.bound.identity_cid,second.agent_cid);assert.equal(network.counts().redeems,2);
 }finally{await a?.close();await b?.close();await c?.close();await rm(dir,{recursive:true,force:true});}
});
test('uncertain redemption retains identity and durable attempt; restart cannot redeem again or invent room binding',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'au-unknown-')),network=daemon();let a,b;
 try{a=await open(personal,dir,network);const failed=await a.call('connect_to_room',{invite:'uncertain'});assert.equal(failed.error.identity_retained,true);assert.ok(failed.error.connection_id);await a.close();a=null;b=await open(personal,dir,network);
  assert.equal((await b.call('connect_to_room',{connection_id:failed.error.connection_id})).error.code,'connection_outcome_unresolved');assert.equal((await b.call('connect_to_room',{invite:'uncertain'})).error.code,'invite_already_attempted');assert.equal(network.counts().redeems,1);assert.equal(network.identities.size,1);
 }finally{await a?.close();await b?.close();await rm(dir,{recursive:true,force:true});}
});
test('registry uses private files and rejects symlink records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'au-registry-'));try{const registry=new ConnectionRegistry(dir),row=await registry.reserve('personal','invite');assert.equal((await stat(registry.root)).mode&0o777,0o700);assert.equal((await stat(registry.file(row.connection_id))).mode&0o777,0o600);await rm(registry.file(row.connection_id));await symlink('/etc/passwd',registry.file(row.connection_id));await assert.rejects(registry.get(row.connection_id,'personal'));}finally{await rm(dir,{recursive:true,force:true});}
});
test('reconnect rejects a changed stored identity CID without redeeming or replacing it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'au-changed-')),network=daemon();let a,b;
 try{a=await open(personal,dir,network);const first=(await a.call('connect_to_room',{invite:'first'})).data;await a.close();a=null;network.identities.get(first.as_agent).cid='C'.repeat(64);b=await open(personal,dir,network);assert.equal((await b.call('connect_to_room',{connection_id:first.connection_id})).error.code,'identity_mismatch');assert.equal(b.session.bound,null);assert.equal(network.counts().creates,1);assert.equal(network.counts().redeems,1);}finally{await a?.close();await b?.close();await rm(dir,{recursive:true,force:true});}
});
test('registry write failure after persistent creation retains identity and reports its recorded connection',async()=>{
 const {connectInvite}=await import('../src/invite-session.mjs');const dir=await mkdtemp(join(tmpdir(),'au-write-failure-')),network=daemon(),registry=new ConnectionRegistry(dir),session=new CoworkSession({resolve:()=>({expectStateDir:dir}),attach:network.attach});
 try{registry.update=async()=>{throw Error('disk unavailable');};session.connections=registry;await assert.rejects(connectInvite(session,'once','personal'),error=>!!error.connection_id&&error.identity_retained===true&&error.identity_name.startsWith('cowork-personal-'));assert.equal(network.identities.size,1);assert.equal(network.counts().redeems,0);assert.equal((await registry.list('personal'))[0].state,'reserved');assert.equal(session.bound,null);}finally{await session.release();await rm(dir,{recursive:true,force:true});}
});
test('default legacy catalogue also stays under daemon state without creating a home catalogue',async()=>{
 const {spawn}=await import('node:child_process');const dir=await mkdtemp(join(tmpdir(),'au-home-isolation-'));
 try{const source=new URL('../src/registry.mjs',import.meta.url).href;const code=`import {RoomRegistry} from ${JSON.stringify(source)};const r=new RoomRegistry(${JSON.stringify(dir)});await r.init();console.log(r.appHome);`;
  const env={...process.env,HOME:dir};delete env.AC_LEGACY_ROOM_REGISTRY;
  const output=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{env});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(out):reject(Error(err)));});assert.equal(output.trim(),join(dir,'cowork-personal-legacy'));await assert.rejects(stat(join(dir,'.au-cowork-personal')),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

for(const [profile,factory] of [['personal',personal],['moderator',moderator]])test(`${profile} remote cold reconnect retains persistent identity and scopes the saved connection to the endpoint`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'au-remote-persist-')),network=daemon();let a,b;
 try{
  a=await open(factory,dir,network,true);const first=(await a.call('connect_to_room',{invite:'remote-once'})).data;assert.equal(first.identity_lifetime,'persistent');
  await a.close();a=null;assert.equal(network.identities.size,1);
  b=await open(factory,dir,network,true);const listed=(await b.call('list_rooms')).data.rooms;assert.equal(listed.length,1);assert.equal(listed[0].connection_id,first.connection_id);
  const resumed=(await b.call('connect_to_room',{connection_id:first.connection_id})).data;assert.equal(resumed.agent_cid,first.agent_cid);assert.equal(network.counts().redeems,1);assert.equal(network.counts().creates,1);
 }finally{await a?.close();await b?.close();await rm(dir,{recursive:true,force:true});}
});
