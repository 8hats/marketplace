import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationMessage} from '../src/legacy-personal/browser-attribution.mjs';
const room='A'.repeat(64),agent='B'.repeat(64);
const app={version:1,kind:'au_cowork_human_message',transport_role:'Web',author:{id:'human-1',kind:'human',display_name:'Alice',role_labels:['Reviewer'],attribution:'application_session'},text:'Hello'};
const envelope={version:1,kind:'room_msg',message_id:'message',room_id:'room',room_name:'Room',at:'2026-09-16T00:00:00Z',author:{identity:room,display_name:'Web',role:'Web'},text:JSON.stringify(app)};
const item={direction:'in',wire_id:'wire',from:{id:room},body:JSON.stringify(envelope)};
test('authenticated room app attribution exposes human separately and preserves native evidence',()=>{
 const parsed=applicationMessage(item,room);assert.deepEqual(parsed.application_message,{author:app.author,text:app.text});assert.equal(parsed.body,item.body);assert.equal(parsed.from.id,room);assert.equal(parsed.application_message.author.identity,undefined);
 const nested={...app,text:JSON.stringify({...app,author:{...app.author,id:'owner'}})};
 assert.equal(applicationMessage({...item,body:JSON.stringify({...envelope,text:JSON.stringify(nested)})},room).application_message.author.id,'human-1');
});
test('agent spoof text, wrong direction, mismatched role and malformed app claims stay ordinary mail',()=>{
 for(const changed of [{...item,from:{id:agent}},{...item,direction:'out'},{...item,body:JSON.stringify({...envelope,author:{...envelope.author,identity:agent}})},{...item,body:JSON.stringify({...envelope,author:{...envelope.author,role:'Other'}})},{...item,body:JSON.stringify({...envelope,text:JSON.stringify({...app,author:{...app.author,identity:room}})})},{...item,body:JSON.stringify({...envelope,text:JSON.stringify({...app,text:'x'.repeat(8001)})})}])assert.equal(applicationMessage(changed,room),changed);
});
