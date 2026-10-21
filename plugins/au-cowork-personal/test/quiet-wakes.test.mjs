import test from 'node:test';
import assert from 'node:assert/strict';
import {CentralClient as Personal} from '../src/central-client.mjs';
import {CentralClient as Moderator} from '../../au-cowork-moderator/src/central-client.mjs';

// Wakes carry news only: own command echoes and repeated heartbeats stay staged but silent.
const event=(seq,kind,resource)=>({event_id:'event-'+seq,seq,kind,resource});
const echo=event(1,'commandResult',{kind:'command',id:'own-command'});
const mail=seq=>event(seq,'postMessage',{kind:'message',id:'mail-'+seq});
const heartbeat=seq=>event(seq,'roomHeartbeatNotice',{kind:'message',id:'heartbeat-'+seq});
const offline=()=>Object.assign(new Error('offline'),{code:'central_unavailable'});
function monitor(Client,pages,{command}={}){
 const hints=[];let polls=0;
 const client=new Client({store:{async save(){},async release(){}},onEvent:value=>hints.push(value.event.event_id)});
 client.row={connection_id:'original',cursor:0,staged:[],consumed_files:[],expires_at:'2099-01-01T00:00:00Z'};
 client.request=async(route,options)=>{
  if(route.startsWith('/events?')){
   const index=polls++;
   if(index===pages.length){client.monitor.abort();throw offline();}
   const events=await pages[index]({client,hints});
   return {events,cursor:Math.max(client.row.cursor,...events.map(item=>item.seq))};
  }
  // The room's current heartbeat is always the newest one staged.
  if(route==='/session')return {room:{heartbeat:{current_id:client.row.staged.filter(item=>item.kind==='roomHeartbeatNotice').at(-1)?.resource.id??null}}};
  if(route==='/ack'){client.row.staged=client.row.staged.filter(item=>!options.body.event_ids.includes(item.event_id));return {};}
  if(route==='/commands'){await command;return {command_id:'own-command',state:'completed',result:{status:'ok',data:{}}};}
  if(route==='/commands/own-command')return {command_id:'own-command',state:'completed',result:{status:'ok',data:{}}};
  if(route.startsWith('/messages/'))return {id:route.slice(10),author:{id:'other'},text:'news',at:'2026-01-01T00:00:00Z'};
  throw new Error('unexpected '+route);
 };
 return {client,hints,run:()=>{client.startMonitor();return client.work;}};
}
for(const [profile,Client] of [['Personal',Personal],['Moderator',Moderator]]){
 test(`${profile}: an own command echo is staged and readable but does not wake; another participant's message does`,async()=>{
  let release;const command=new Promise(resolve=>{release=resolve;});
  const {client,hints,run}=monitor(Client,[
   // The echo can arrive before the command response; it waits for the response, then stays silent.
   ({client})=>{void client.mutation('/commands',{body:{command:'consumer.ac.read',arguments:{kind:'room'}}});return [echo];},
   async()=>{release();await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(hints,[]);return [mail(2)];},
  ],{command});
  await run();
  assert.deepEqual(hints,[mail(2).event_id]);
  assert.deepEqual(client.row.own_commands,['own-command']);
  assert.deepEqual(client.row.staged.map(item=>item.event_id),[echo.event_id,mail(2).event_id]);
  const read=await client.messages();
  assert.equal(read.command_results[0].request_wire_id,'own-command');assert.equal(read.messages[0].wire_id,'mail-2');
 });
 test(`${profile}: two heartbeats with nothing between wake once; a participant message re-arms the next heartbeat`,async()=>{
  const quiet=monitor(Client,[()=>[heartbeat(1)],()=>[heartbeat(2)],()=>[heartbeat(3)]]);
  await quiet.run();
  assert.deepEqual(quiet.hints,[heartbeat(1).event_id]);
  // Never dropped: the current heartbeat is still staged for ac_messages.
  assert.deepEqual(quiet.client.row.staged.map(item=>item.event_id),[heartbeat(3).event_id]);
  const busy=monitor(Client,[()=>[heartbeat(1)],()=>[mail(2)],()=>[heartbeat(3)],()=>[heartbeat(4)]]);
  await busy.run();
  assert.deepEqual(busy.hints,[heartbeat(1).event_id,mail(2).event_id,heartbeat(3).event_id]);
 });
}
