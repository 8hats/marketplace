import assert from 'node:assert/strict';
import test from 'node:test';
import { CoworkSession } from '../src/session.mjs';

test('release is idempotent and next operation attaches a fresh client', async () => {
  let attached = 0; let released = 0;
  const session = new CoworkSession({ resolve: () => ({ expectStateDir: '/x' }), attach: async () => ({ id: ++attached, async releaseLease() { released++; } }) });
  assert.equal((await session.ensureAttached()).id, 1); await session.release(); await session.release();
  assert.equal((await session.ensureAttached()).id, 2); assert.equal(released, 1);
});

test('remote attachment never resolves local state, keeps owner on reconnect, replaces owner after release',async()=>{
 const owners=[];let released=0;
 const session=new CoworkSession({remote:{url:'https://example.test'},resolve:()=>{throw Error('local state touched');},attach:()=>{throw Error('local attach touched');},attachRemoteFn:async(_selection,options)=>{owners.push(options.leaseToken);return {releaseLease:async()=>{released++;},close:async()=>{}};}});
 await session.ensureAttached();session.client=null;await session.ensureAttached();assert.equal(owners[0],owners[1]);
 await session.release();await session.ensureAttached();assert.notEqual(owners[1],owners[2]);assert.equal(released,1);
});

test('local resolved endpoint and credential are passed coherently to attach',async()=>{
 let options;const session=new CoworkSession({remote:null,resolve:()=>({baseUrl:{value:'http://127.0.0.1:1234'},expectStateDir:'/selected',token:{value:'local-test-token'}}),attach:async value=>{options=value;return {};}});
 await session.ensureAttached();assert.equal(options.endpoint,'http://127.0.0.1:1234');assert.equal(options.expectStateDir,'/selected');assert.equal(options.token,'local-test-token');assert.deepEqual(options.env,{});
});

test('remote release failure retains the owner for inspection and retry',async()=>{
 let calls=0;const client={releaseLease:async()=>{if(++calls===1)throw Object.assign(Error('unreachable'),{code:'remote_unavailable'});},close:async()=>{}};
 const session=new CoworkSession({remote:{url:'https://example.test'},attachRemoteFn:async()=>client});
 await session.ensureAttached();const owner=session.ownerToken;
 await assert.rejects(session.release(),{code:'remote_unavailable'});assert.equal(session.client,client);assert.equal(session.ownerToken,owner);
 await session.release();assert.equal(session.client,null);assert.notEqual(session.ownerToken,owner);
});

test('configuration is read after startup, frozen until release, then refreshed',async()=>{
 let configured=null,reads=0;const endpoints=[];
 const session=new CoworkSession({resolveRemote:()=>{reads++;return configured;},resolve:()=>{throw Error('local selection touched');},attachRemoteFn:async config=>{endpoints.push(config.url);return {releaseLease:async()=>{},close:async()=>{}};}});
 assert.equal(reads,0);
 configured={url:'https://first.example'};await session.ensureAttached();
 configured={url:'https://second.example'};await session.ensureAttached();
 assert.deepEqual(endpoints,['https://first.example']);
 await session.release();await session.ensureAttached();
 assert.deepEqual(endpoints,['https://first.example','https://second.example']);
});
