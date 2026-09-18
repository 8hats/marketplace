import test from 'node:test';
import assert from 'node:assert/strict';
import {ForegroundWait} from '../src/foreground-wait.mjs';
const cid='A'.repeat(64),agent='B'.repeat(64);
function fixture(){
 const row={identity_name:'Agent',identity_cid:agent,contact_cid:cid,room_name:'Room'},listeners=new Set();
 let identity={name:'Agent',cid:agent},reads=0;
 const client={currentIdentity:async()=>identity,listIncomingMessages:async()=>{reads++;return [];},listIncomingFiles:async()=>[]};
 const session={bound:row,ensureAttached:async()=>client};
 const monitor={subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},handle:async(_client,r,event)=>{for(const fn of listeners)fn(r,{room_name:r.room_name,event:'room_message_available',wire_id:event.wire_id,sender_cid:cid});},wakeRetained:(r,item)=>{for(const fn of listeners)fn(r,{event:'room_message_available',wire_id:item.wire_id,sender_cid:cid});}};
 const waiter=new ForegroundWait({session,monitor,retained:async()=>[]});
 return {row,client,session,monitor,waiter,listeners,counts:()=>reads,change:()=>{identity={name:'Other',cid:agent};},emit:()=>{for(const fn of listeners)fn(row,{event:'room_message_available',wire_id:'wire',sender_cid:cid});},stop:()=>{session.bound=null;for(const fn of listeners)fn(null,null);}};
}
test('wait subscribes before unread snapshot and does not consume mail',async()=>{
 const f=fixture();f.client.listIncomingMessages=async()=>{f.emit();return [];};const value=await f.waiter.wait({timeout_ms:100});assert.equal(value.status,'event');assert.equal(value.event.wire_id,'wire');assert.equal(f.listeners.size,0);
});
test('already unread and retained messages produce events',async()=>{
 const f=fixture();f.client.listIncomingMessages=async()=>[{wire_id:'old',from:{id:cid}}];assert.equal((await f.waiter.wait({timeout_ms:100})).event.wire_id,'old');
 const g=fixture();g.waiter.retained=async()=>[{wire_id:'retained',direction:'in',from:{id:cid}}];assert.equal((await g.waiter.wait({timeout_ms:100})).event.wire_id,'retained');
});
test('timeout, cancellation, disconnect and single waiter clean subscriptions',async()=>{
 const f=fixture();assert.equal((await f.waiter.wait({timeout_ms:5})).status,'timeout');assert.equal(f.listeners.size,0);
 const abort=new AbortController(),pending=f.waiter.wait({timeout_ms:1000},abort.signal);assert.equal((await f.waiter.wait({timeout_ms:1000})).status,'already_waiting');abort.abort();assert.equal((await pending).status,'cancelled');assert.equal(f.listeners.size,0);
 const disconnected=f.waiter.wait({timeout_ms:1000});f.stop();assert.equal((await disconnected).status,'disconnected');assert.equal(f.listeners.size,0);
});
test('identity mismatch fails closed and session waits remain independent',async()=>{
 const a=fixture(),b=fixture();a.change();assert.equal((await a.waiter.wait({timeout_ms:100})).status,'identity_mismatch');
 const p=b.waiter.wait({timeout_ms:1000});a.stop();b.emit();assert.equal((await p).status,'event');assert.equal(b.listeners.size,0);
});
test('file events require authenticated inbound file metadata',async()=>{
 const f=fixture();f.client.listIncomingFiles=async()=>[{wire_id:'file',from:{id:cid}}];f.monitor.handle=async()=>{for(const fn of f.listeners)fn(f.row,{event:'room_file_available',file_id:'file'});};
 f.client.getFileInfo=async()=>({direction:'out',from:{id:cid}});assert.equal((await f.waiter.wait({timeout_ms:5})).status,'timeout');
 f.client.getFileInfo=async()=>({direction:'in',from:{id:cid},filename:'secret'});const result=await f.waiter.wait({timeout_ms:100});assert.equal(result.status,'event');assert.doesNotMatch(JSON.stringify(result),/secret|filename/);
});
