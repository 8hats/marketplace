import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {CentralClient,ConnectionStore,retryAfterMillis} from '../src/central-client.mjs';
import {createRuntime} from '../src/server.mjs';

const id='11111111-1111-4111-8111-111111111111';
const origin='https://cowork.example';
const secret='DO_NOT_ECHO_RESPONSE_SECRET';
const event={event_id:'event',seq:1,kind:'message',resource:{kind:'message',id:'message'}};
const row=extra=>({version:1,connection_id:id,credential:'a'.repeat(43),origin,room_name:'Room',room_id:'room',agent_id:'agent',display_name:'Agent',expires_at:'2099-01-01T00:00:00.000Z',cursor:0,staged:[],consumed_files:[],watch_enabled:true,...extra});
const json=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
const hold=options=>delay(100000,undefined,{signal:options.signal});
// A controlled body proves retryable status classification happens before reading JSON.
function syntheticResponse({status=200,text='',headers={'content-type':'text/html'},readError}={}){
 const stats={reads:0,cancels:0,released:0};let done=false;
 const reader={async read(){stats.reads++;if(readError)throw readError;if(done)return {done:true};done=true;return {done:false,value:Buffer.from(text)};},async cancel(){stats.cancels++;},releaseLock(){stats.released++;}};
 return {response:{status,ok:status>=200&&status<300,headers:new Headers(headers),body:{getReader:()=>reader,async cancel(){stats.cancels++;}}},stats};
}
async function fixture(t,options={},extra={}){
 const temporary=await fs.mkdtemp(path.join(tmpdir(),'cowork-connectivity-'));
 const store=new ConnectionStore(path.join(temporary,'private'));
 await store.save(row(extra));
 const client=new CentralClient({store,origin,...options});
 t.after(async()=>{await client.disconnect();await fs.rm(temporary,{recursive:true,force:true});});
 return {client,store};
}
async function until(predicate){
 for(let n=0;n<600;n++){if(predicate())return;await delay(5);}
 assert.fail('monitor did not reach the expected state');
}
function diagnostic(value,{endpoint='/events',status=200,type='application/json',reason}={}){
 assert.deepEqual(Object.keys(value).sort(),['content_type','endpoint','http_status','reason','timestamp']);
 assert.equal(value.endpoint,endpoint);assert.equal(value.http_status,status);assert.equal(value.content_type,type);
 assert.equal(typeof value.reason,'string');if(reason)assert.equal(value.reason,reason);
 assert.equal(new Date(value.timestamp).toISOString(),value.timestamp);
 assert.equal(JSON.stringify(value).includes(secret),false);
 assert.equal(JSON.stringify(value).includes(origin),false);
 assert.equal(JSON.stringify(value).includes('a'.repeat(43)),false);
}
function health(client){
 const result=client.monitorHealth();
 assert.deepEqual(Object.keys(result).sort(),['consecutive_failures','diagnostic','last_success_at','live','malformed_failures','next_retry_ms','pending_events','state']);
 assert.equal(result.state,client.monitorState);assert.equal(typeof result.live,'boolean');
 return result;
}

test('Retry-After accepts seconds and HTTP dates, caps and rejects invalid values',()=>{
 const now=Date.parse('Wed, 01 Jan 2025 00:00:00 GMT');
 for(const [value,expected] of [['0',0],['2',2000],[' 7 ',7000],['61',60000],['999999999',60000],['Wed, 01 Jan 2025 00:00:04 GMT',4000],['Wed, 01 Jan 2025 00:10:00 GMT',60000],['Tue, 31 Dec 2024 23:59:59 GMT',0],[undefined,0],[null,0],[2,0],['',0],['-2',0],['1.5',0],['Infinity',0],['tomorrow',0],['2025-01-01',0]])assert.equal(retryAfterMillis(value,now),expected,String(value));
});

test('retryable HTTP statuses cancel before parsing HTML or JSON error bodies',async t=>{
 const {client}=await fixture(t);
 for(const status of [408,425,429,...Array.from({length:100},(_,n)=>500+n).filter(n=>![501,505].includes(n))]){
  for(const text of ['<html>'+secret+'</html>',JSON.stringify({error:{code:'unauthenticated',message:secret}})]){
   const {response,stats}=syntheticResponse({status,text,headers:{'content-type':'text/html; private='+secret,'retry-after':'45','x-secret':secret}});
   client.fetchFn=async()=>response;
   await assert.rejects(()=>client.request('/events?credential='+secret),error=>{
    assert.equal(error.code,status===429?'rate_limited':'central_unavailable');assert.equal(error.retry_after_ms,45000);
    diagnostic(error.diagnostic,{status,type:'text/html'});return true;
   });
   assert.equal(stats.reads,0);assert.equal(stats.cancels,1);
  }
 }
});

test('non-JSON authorization and permanent HTTP failures retain classification; JSON codes survive',async t=>{
 const {client}=await fixture(t);
 for(const [status,code] of [[401,'unauthenticated'],[403,'forbidden'],[404,'central_http_error'],[501,'central_http_error'],[505,'central_http_error']]){
  client.fetchFn=async()=>syntheticResponse({status,text:'<html>'+secret+'</html>'}).response;
  await assert.rejects(()=>client.request('/messages/'+secret+'?token='+secret),error=>{
   assert.equal(error.code,code);diagnostic(error.diagnostic,{endpoint:'/messages/:id',status,type:'text/html'});return true;
  });
 }
 for(const [status,code] of [[401,'expired'],[403,'result_visibility_changed'],[409,'database_busy'],[501,'unsupported']]){
  client.fetchFn=async()=>new Response(JSON.stringify({error:{code,message:secret,body:secret}}),{status,headers:{'content-type':'application/json; secret='+secret}});
  await assert.rejects(()=>client.request('/commands/'+secret+'?token='+secret),error=>{
   assert.equal(error.code,code);diagnostic(error.diagnostic,{endpoint:'/commands/:id',status});return true;
  });
 }
});

test('401/403 JSON retry codes cannot weaken authorization failure',async t=>{
 const {client}=await fixture(t);
 for(const status of [401,403])for(const code of ['central_unavailable','database_busy','rate_limited','invalid_central_response']){
  client.fetchFn=async()=>new Response(JSON.stringify({error:{code}}),{status,headers:{'content-type':'application/json'}});
  await assert.rejects(()=>client.request('/events'),{code:status===401?'unauthenticated':'forbidden'});
 }
});

test('arbitrary MIME tokens cannot leak a reflected credential into diagnostics',async t=>{
 const {client}=await fixture(t);
 client.fetchFn=async()=>new Response('invalid',{headers:{'content-type':'application/'+'a'.repeat(43)}});
 await assert.rejects(()=>client.request('/events'),error=>{diagnostic(error.diagnostic,{type:null,reason:'invalid_json'});return true;});
});

test('an HTML gateway failure never automatically replays a mutation and preserves its key',async t=>{
 let sends=0;const keys=[];
 const {client,store}=await fixture(t,{fetchFn:async(url,options)=>{
  if(url.includes('/events'))return hold(options);
  if(url.endsWith('/messages')){
   sends++;keys.push(JSON.parse(options.body).idempotency_key);
   return sends===1?new Response('<html>gateway</html>',{status:503}):json({sent:true});
  }
  throw Error('unexpected synthetic request');
 }});
 await client.restore();
 await assert.rejects(()=>client.mutation('/messages',{body:{text:'One send'}}),{code:'central_unavailable'});
 assert.equal(sends,1);assert.deepEqual(Object.values((await store.load(id)).pending_operations),[keys[0]]);
 await client.mutation('/messages',{body:{text:'One send'}});
 assert.equal(sends,2);assert.equal(keys[0],keys[1]);assert.deepEqual((await store.load(id)).pending_operations,{});
});

test('successful invalid JSON and missing data use fixed sanitized reasons',async t=>{
 const {client}=await fixture(t);
 for(const [text,reason] of [[secret,'invalid_json'],[JSON.stringify({private:secret}),'missing_data']]){
  client.fetchFn=async()=>syntheticResponse({text,headers:{'content-type':'application/json; token='+secret}}).response;
  await assert.rejects(()=>client.request('/events?after='+secret),error=>{
   assert.equal(error.code,'invalid_central_response');diagnostic(error.diagnostic,{reason});return true;
  });
 }
 client.fetchFn=async()=>syntheticResponse({text:secret,headers:{'content-type':secret}}).response;
 await assert.rejects(()=>client.request('/'+secret+'?secret='+secret),error=>{diagnostic(error.diagnostic,{endpoint:'/unknown',type:null,reason:'invalid_json'});return true;});
});

for(const status of [401,403])test('oversized '+status+' body remains an authorization stop',async t=>{
 let polls=0;const {client}=await fixture(t,{fetchFn:async()=>{polls++;return new Response('x'.repeat(4*1024*1024+1),{status});}});
 await client.restore();await until(()=>client.monitorState===(status===401?'unauthenticated':'forbidden'));
 assert.equal(polls,1);assert.equal(client.row.cursor,0);
 await assert.rejects(()=>client.request('/messages/message'),{code:status===401?'unauthenticated':'forbidden'});
 assert.equal(polls,1);assert.equal(health(client).live,false);
});

test('hanging or rejecting cancellation cannot stall HTTP or size classification',async t=>{
 const {client}=await fixture(t);
 for(const status of [503,200])for(const reject of [false,true]){
  let cancels=0;
  const body=new ReadableStream({start(controller){if(status===200)controller.enqueue(Buffer.alloc(4*1024*1024+1));},cancel(){cancels++;return reject?Promise.reject(Error(secret)):new Promise(()=>{});}});
  client.fetchFn=async()=>new Response(body,{status});
  let timer;const bounded=promise=>Promise.race([promise,new Promise((_,fail)=>{timer=setTimeout(()=>fail(Error('cancellation stalled')),1000);})]).finally(()=>clearTimeout(timer));
  await assert.rejects(()=>bounded(client.request('/events')),{code:status===503?'central_unavailable':'response_too_large'});
  assert.equal(cancels,1);
 }
});

test('caller cancellation wins when a synthetic fetch still returns HTTP 503',async t=>{
 const {client}=await fixture(t,{fetchFn:async()=>new Response('error',{status:503})});
 const signal=AbortSignal.abort();await assert.rejects(()=>client.request('/events',{signal}),{code:'cancelled'});
});

test('reserved server error labels cannot falsely report a healthy terminal monitor',async t=>{
 const {client}=await fixture(t,{fetchFn:async()=>new Response(JSON.stringify({error:{code:'running'}}),{status:409,headers:{'content-type':'application/json'}})});
 await client.restore();await until(()=>client.monitorState==='central_http_error');
 assert.equal(health(client).live,false);assert.equal(client.row.cursor,0);
});

test('any HTTP authorization error remains fail-closed regardless of its JSON label',async t=>{
 const {client}=await fixture(t,{fetchFn:async()=>new Response(JSON.stringify({error:{code:'running'}}),{status:401,headers:{'content-type':'application/json'}})});
 await client.restore();await until(()=>client.monitorState==='unauthenticated');
 await assert.rejects(()=>client.request('/messages/message'),{code:'unauthenticated'});assert.equal(health(client).live,false);
});

test('network/body transport, explicit cancellation and body size stay distinct and sanitized',async t=>{
 const {client}=await fixture(t);
 client.fetchFn=async()=>{throw Error(secret);};
 await assert.rejects(()=>client.request('/events?token='+secret),error=>{assert.equal(error.code,'central_unavailable');diagnostic(error.diagnostic,{status:null,type:null});return true;});
 const broken=syntheticResponse({readError:new TypeError(secret)});client.fetchFn=async()=>broken.response;
 await assert.rejects(()=>client.request('/events'),error=>{assert.equal(error.code,'central_unavailable');diagnostic(error.diagnostic,{type:'text/html'});return true;});
 assert.equal(broken.stats.released,1);
 const abort=new AbortController();abort.abort();
 await assert.rejects(()=>client.request('/events',{signal:abort.signal}),error=>{assert.equal(error.code,'cancelled');diagnostic(error.diagnostic,{type:'text/html'});return true;});
 const oversized=syntheticResponse({text:'x'.repeat(4*1024*1024+1)});client.fetchFn=async()=>oversized.response;
 await assert.rejects(()=>client.request('/events'),error=>{assert.equal(error.code,'response_too_large');diagnostic(error.diagnostic,{type:'text/html'});return true;});
 assert.equal(oversized.stats.cancels,1);
});

test('an HTML 502 retries once then stages a valid page and resets health',async t=>{
 let polls=0;const waits=[];
 const {client,store}=await fixture(t,{retryDelayFn:async ms=>waits.push(ms),fetchFn:async(url,options)=>{
  polls++;if(polls===1)return syntheticResponse({status:502,text:'<html>'+secret+'</html>'}).response;
  if(polls===2)return json({events:[event],cursor:1});return hold(options);
 }});
 await client.restore();await until(()=>client.row.cursor===1);
 assert.equal(waits.length,1);assert.equal(client.monitorState,'running');
 assert.deepEqual((await store.load(id)).staged,[event]);
 const snapshot=health(client);assert.equal(snapshot.live,true);assert.equal(snapshot.consecutive_failures,0);assert.equal(snapshot.malformed_failures,0);assert.equal(snapshot.next_retry_ms,0);assert.ok(Number.isFinite(Date.parse(snapshot.last_success_at)));
 const result=await client.wait(1000);assert.equal(result.status,'event');assert.deepEqual(result.monitor,client.monitorHealth());
});

test('503, 504, network and JSON 429 retry indefinitely with bounded jitter and Retry-After floor',async t=>{
 let polls=0;const waits=[],snapshots=[];
 const {client}=await fixture(t,{retryDelayFn:async ms=>{waits.push(ms);snapshots.push(client.monitorHealth());},fetchFn:async(url,options)=>{
  polls++;if(polls>12){if(polls===13)return json({events:[],cursor:0});return hold(options);}
  const kind=(polls-1)%4;if(kind===2)throw Error(secret);
  return syntheticResponse({status:[503,504,0,429][kind],text:JSON.stringify({error:{code:'forbidden',secret}}),headers:{'content-type':'application/json','retry-after':kind===3?'90':'0'}}).response;
 }});
 await client.restore();await until(()=>polls===14);
 assert.equal(waits.length,12);
 for(let n=0;n<waits.length;n++){
  const base=Math.min(30000,500*2**Math.min(n,6));
  if(n%4===3)assert.equal(waits[n],60000);
  else assert.ok(waits[n]>=Math.floor(base*.75)&&waits[n]<=Math.min(30000,Math.ceil(base*1.25)));
  assert.equal(snapshots[n].next_retry_ms,waits[n]);assert.equal(snapshots[n].consecutive_failures,n+1);assert.equal(snapshots[n].malformed_failures,0);assert.equal(snapshots[n].state,'reconnecting');assert.equal(typeof snapshots[n].live,'boolean');
 }
 assert.equal(health(client).consecutive_failures,0);
});

for(const [text,reason] of [['<html>'+secret+'</html>','invalid_json'],[JSON.stringify({secret}),'missing_data']])test('malformed HTTP 200 '+reason+' stops at the third failure without advancing durable state',async t=>{
 let polls=0;const waits=[];
 const {client,store}=await fixture(t,{retryDelayFn:async ms=>waits.push(ms),fetchFn:async()=>{polls++;return syntheticResponse({text,headers:{'content-type':'application/json'}}).response;}});
 await client.restore();await client.work;
 assert.equal(polls,3);assert.equal(waits.length,2);assert.equal(client.monitorState,'invalid_central_response');
 const snapshot=health(client);assert.equal(snapshot.live,false);assert.equal(snapshot.malformed_failures,3);assert.equal(snapshot.consecutive_failures,3);assert.equal(snapshot.next_retry_ms,0);diagnostic(snapshot.diagnostic,{reason});
 assert.equal((await store.load(id)).cursor,0);assert.deepEqual((await store.load(id)).staged,[]);
 const result=await client.wait(1000);assert.equal(result.status,'unavailable');assert.equal(result.code,'invalid_central_response');assert.deepEqual(result.monitor,snapshot);
});

test('transport retries do not erase the malformed-page budget without a successful page',async t=>{
 let polls=0,retries=0;
 const {client}=await fixture(t,{retryDelayFn:async()=>{retries++;},fetchFn:async()=>{
  polls++;if(polls===2)throw Error('synthetic outage');return new Response('invalid');
 }});
 await client.restore();await client.work;
 assert.equal(polls,4);assert.equal(retries,3);assert.equal(health(client).malformed_failures,3);assert.equal(health(client).consecutive_failures,4);assert.equal(client.monitorState,'invalid_central_response');
});

test('a valid page resets the malformed-page budget before a later malformed streak',async t=>{
 let polls=0;const waits=[];
 const {client}=await fixture(t,{retryDelayFn:async ms=>waits.push(ms),fetchFn:async()=>{
  polls++;return polls===3?json({events:[],cursor:0}):new Response('invalid');
 }});
 await client.restore();await client.work;
 assert.equal(polls,6);assert.equal(waits.length,4);assert.equal(health(client).malformed_failures,3);assert.equal(client.monitorState,'invalid_central_response');
});

for(const [page,reason] of [
 [{events:[],cursor:-1},'invalid_cursor'],[{events:[],cursor:1.5},'invalid_cursor'],[{events:[],cursor:Number.MAX_SAFE_INTEGER+1},'invalid_cursor'],[{events:[]},'invalid_cursor'],
 [{events:[{...event,seq:3}],cursor:2},'invalid_event_sequence'],[{events:[{...event,seq:1.5}],cursor:2},'invalid_event_sequence'],[{events:[{...event,seq:0}],cursor:2},'invalid_event_sequence'],
 [{events:[{...event,seq:2},{...event,event_id:'second',seq:1}],cursor:2},'invalid_event_sequence'],
 [{events:[{...event,seq:1},{...event,event_id:'second',seq:1}],cursor:2},'invalid_event_sequence']
])test('event integrity '+reason+' '+JSON.stringify(page)+' is terminal immediately',async t=>{
 let polls=0,retries=0;
 const {client,store}=await fixture(t,{retryDelayFn:async()=>{retries++;},fetchFn:async()=>{polls++;return json(page);}});
 await client.restore();await client.work;
 assert.equal(polls,1);assert.equal(retries,0);assert.equal(client.monitorState,'invalid_central_response');
 assert.equal(health(client).live,false);diagnostic(health(client).diagnostic,{reason});
 assert.equal(client.row.cursor,0);assert.deepEqual(client.row.staged,[]);assert.equal((await store.load(id)).cursor,0);assert.deepEqual((await store.load(id)).staged,[]);
});

test('a backward cursor preserves previously staged mail and cursor',async t=>{
 let retries=0;
 const {client,store}=await fixture(t,{retryDelayFn:async()=>{retries++;},fetchFn:async()=>json({events:[],cursor:0})},{cursor:1,staged:[event]});
 await client.restore();await client.work;assert.equal(retries,0);
 assert.equal((await store.load(id)).cursor,1);assert.deepEqual((await store.load(id)).staged,[event]);diagnostic(health(client).diagnostic,{reason:'invalid_cursor'});
});

for(const [status,code] of [[401,'unauthenticated'],[403,'forbidden']])test('HTML '+status+' authorization stops immediately and blocks queued mail reads',async t=>{
 let polls=0,retries=0;
 const {client,store}=await fixture(t,{retryDelayFn:async()=>{retries++;},fetchFn:async()=>{polls++;return new Response('<html>'+secret+'</html>',{status});}},{cursor:1,staged:[event]});
 await client.restore();await client.work;assert.equal(polls,1);assert.equal(retries,0);assert.equal(client.monitorState,code);assert.equal(health(client).live,false);
 await assert.rejects(()=>client.messages(),{code});assert.equal(polls,1);assert.equal((await store.load(id)).cursor,1);assert.deepEqual((await store.load(id)).staged,[event]);
});

test('protocol-stopped monitor exposes queued event and allows message fetch and acknowledgement; runtime exposes health',async t=>{
 const calls=[],handlers=new Map();
 const {client,store}=await fixture(t,{retryDelayFn:async()=>{},fetchFn:async(url,options)=>{
  calls.push(url);
  if(url.includes('/events'))return new Response('invalid');
  if(url.endsWith('/session'))return json({room:{id:'room'}});
  if(url.endsWith('/messages/message'))return json({id:'message',author:{id:'human'},text:'Queued mail'});
  if(url.endsWith('/ack')){assert.deepEqual(JSON.parse(options.body).event_ids,['event']);return json({});}
  throw Error('unexpected synthetic endpoint');
 }},{cursor:1,staged:[event]});
 const runtime=await createRuntime({client,injectedServer:{registerTool:(name,descriptor,handler)=>handlers.set(name,handler)}});
 t.after(()=>runtime.shutdown());await client.work;
 const result=await client.wait(1000);assert.equal(result.status,'event');assert.equal(result.monitor.live,false);assert.equal(result.monitor.pending_events,1);assert.equal(result.monitor.state,'invalid_central_response');
 for(const name of ['get_watch_status','get_room_status']){
  const status=(await handlers.get(name)({})).structuredContent;
  assert.equal(status.ok,true);assert.deepEqual(status.data.health,client.monitorHealth());
 }
 const output=(await handlers.get('ac_messages')({})).structuredContent;
 assert.ok(JSON.stringify(output).includes('Queued mail'));assert.ok(calls.some(url=>url.endsWith('/messages/message')));assert.ok(calls.some(url=>url.endsWith('/ack')));
 assert.deepEqual((await store.load(id)).staged,[]);assert.equal((await store.load(id)).cursor,1);assert.equal(health(client).pending_events,0);
});

test('wait includes a fresh monitor snapshot even when disconnected or cancelled',async t=>{
 const {client}=await fixture(t,{fetchFn:async(url,options)=>hold(options)});
 let result=await client.wait(1);assert.equal(result.status,'disconnected');assert.deepEqual(result.monitor,client.monitorHealth());
 assert.deepEqual(health(client),{state:'disconnected',live:false,pending_events:0,consecutive_failures:0,malformed_failures:0,next_retry_ms:0,last_success_at:null,diagnostic:null});
 await client.restore();const abort=new AbortController();const waiting=client.wait(50000,abort.signal);abort.abort();
 result=await waiting;assert.equal(result.status,'cancelled');assert.deepEqual(result.monitor,client.monitorHealth());
});
