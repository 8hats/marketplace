import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductTools} from '../src/product-tools.mjs';
test('legacy reads progress past retained unrelated mail to a later room arrival',async()=>{
 const room='A'.repeat(64),agent='B'.repeat(64);let reads=0;
 const envelope={version:1,kind:'room_msg',room_id:'room-id',room_name:'Room',message_id:'message-id',author:{identity:'C'.repeat(64),display_name:'Peer',role:'Developer'},text:'later room message',at:'2026-09-12T00:00:00Z'};
 const sdk={currentIdentity:async()=>({name:'Agent',cid:agent}),getMessages:async()=>({messages:++reads===1?[{wire_id:'unrelated',from:{id:'D'.repeat(64)},body:'private'}]:[{wire_id:'room-message',from:{id:room},body:JSON.stringify(envelope)}],command_results:[],remaining:0})};
 const session={bound:{room_name:'Room',identity_name:'Agent',contact_cid:room},ensureAttached:async()=>sdk};
 const product=createProductTools(session);
 assert.equal((await product.readLegacy()).messages.length,0);
 const second=await product.readLegacy();
 assert.equal(second.messages.length,1,'the second read should fetch the new room arrival despite retained unrelated mail');
 assert.equal(reads,2);
 const mail=JSON.parse((await product.execute('ac_messages',{})).content[0].text);
 assert.equal(mail.messages[0].wire_id,'unrelated');
});
test('legacy page limit applies after eligibility and preserves a large unrelated prefix',async()=>{
 const {createProductTools}=await import('../src/product-tools.mjs');const room='A'.repeat(64),agent='B'.repeat(64);let reads=0;
 const envelope={version:1,kind:'room_msg',room_id:'r',room_name:'Room',message_id:'m',author:{identity:agent,display_name:'Agent',role:'Developer'},text:'visible',at:'2026-09-12T00:00:00Z'};
 const sdk={currentIdentity:async()=>({name:'Agent',cid:agent}),sendCommand:async()=>({sent:true,wire_id:'request'}),getMessages:async()=>{reads++;return {messages:[...Array.from({length:99},(_,i)=>({wire_id:`other-${i}`,from:{id:'C'.repeat(64)},body:'private'})),{wire_id:'visible',from:{id:room},body:JSON.stringify(envelope)}],command_results:[{wire_id:'reply',direction:'in',message_kind:'command_result',from:{id:room},reply_to:{wire_id:'request'},body:JSON.stringify({ok:true,result:{ok:true,result:{status:'ok',data:{}}}})}],remaining:0};}};
 const product=createProductTools({bound:{room_name:'Room',identity_name:'Agent',contact_cid:room},ensureAttached:async()=>sdk});
 await product.execute('ac_read',{kind:'room'});
 assert.equal((await product.readLegacy(1)).messages[0].message_id,'m');assert.equal(reads,1);
 const mail=JSON.parse((await product.execute('ac_messages',{})).content[0].text);assert.equal(mail.messages.length,99);assert.equal(reads,1);
});
test('legacy fresh polling respects full retained capacity until explicit mail inspection',async()=>{
 const room='A'.repeat(64),agent='B'.repeat(64);let reads=0,sends=0;
 const sdk={currentIdentity:async()=>({name:'Agent',cid:agent}),sendCommand:async()=>{sends++;return {sent:true,wire_id:'request'};},getMessages:async()=>{reads++;return {messages:Array.from({length:100},(_,i)=>({wire_id:`${reads}-${i}`,from:{id:'C'.repeat(64)},body:'private'})),command_results:[],remaining:0};}};
 const product=createProductTools({bound:{room_name:'Room',identity_name:'Agent',contact_cid:room},ensureAttached:async()=>sdk},{timeoutMs:1000,pollMs:1});
 await product.execute('ac_read',{kind:'room'});assert.equal(reads,10);
 assert.equal((await product.readLegacy()).outcome.status,'unknown');assert.equal(reads,10);
 const mail=JSON.parse((await product.execute('ac_messages',{limit:100})).content[0].text);assert.equal(mail.messages.length,100);
 await product.readLegacy();assert.equal(reads,11);assert.equal(sends,1);
});
