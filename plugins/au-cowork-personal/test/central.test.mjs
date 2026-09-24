import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {CentralClient,ConnectionStore,invitation} from '../src/central-client.mjs';
import {centralTools} from '../src/central-tools.mjs';

const secret='a'.repeat(43),origin='https://cowork.example',invite=origin+'/#/agent-invite/'+secret;
const accepted={credential:'b'.repeat(43),room_id:'room',room_name:'Room',agent_id:'agent',display_name:'Agent',expires_at:'2099-01-01T00:00:00.000Z'};
const json=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
test('product tool names and JSON schemas match the baseline transport',async()=>{
 const baseline=JSON.parse(await fs.readFile(new URL('./baseline-tool-schemas.json',import.meta.url),'utf8'));
 const tools=centralTools({});
 for(const tool of tools)assert.equal(createHash('sha256').update(JSON.stringify(zodToJsonSchema(tool.inputSchema,{$refStrategy:'none'}))).digest('hex'),baseline[tool.name],tool.name);
 const omitted=new Set(['ac_join','ac_request_route','ac_review_publish','ac_publication_propose','ac_intervention_record','ac_stage_explain','ac_result_create']);
 assert.deepEqual(tools.map(tool=>tool.name).sort(),Object.keys(baseline).filter(name=>!omitted.has(name)).sort());
});
test('invite parsing rejects HTTP, origin changes and secret-bearing queries',()=>{
 assert.deepEqual(invitation(invite,origin),{origin,token:secret});
 for(const invalid of [invite.replace('https:','http:'),invite.replace('cowork.example','other.example'),origin+'/?token='+secret,origin+'/path#/agent-invite/'+secret])assert.throws(()=>invitation(invalid,origin));
});
test('moderator tool schemas match the baseline without granting a local permission',async()=>{
 const baseline=JSON.parse(await fs.readFile(new URL('./baseline-tool-schemas.json',import.meta.url),'utf8'));
 const tools=centralTools({},'moderator');
 assert.deepEqual(tools.map(tool=>tool.name).sort(),Object.keys(baseline).filter(name=>name!=='ac_join').sort());
 for(const tool of tools)assert.equal(createHash('sha256').update(JSON.stringify(zodToJsonSchema(tool.inputSchema,{$refStrategy:'none'}))).digest('hex'),baseline[tool.name],tool.name);
});
test('credential renewal persists before use and a lost rotation response stops without replay',async()=>{
 for(const lost of [false,true]){
  const root=path.join(await fs.mkdtemp(path.join(tmpdir(),'cowork-renew-')),'private');let rotations=0,polls=0,client;
  const fetchFn=async(url,options)=>{
   if(url.endsWith('/exchange'))return json({...accepted,expires_at:new Date(Date.now()+60000).toISOString()});
   if(url.endsWith('/credentials/rotate')){rotations++;if(lost)throw Error('Response lost');return json({credential:'c'.repeat(43),credential_id:'renewed',expires_at:'2099-01-01T00:00:00.000Z'});}
   if(url.includes('/events')){assert.equal(options.headers.authorization,'Bearer '+'c'.repeat(43));polls++;await delay(100000,undefined,{signal:options.signal});}
   throw Error('unexpected endpoint');
  };
  try{
   client=new CentralClient({store:new ConnectionStore(root),fetchFn});const connection=await client.connect({invite});
   for(let attempt=0;attempt<400&&(lost?client.monitorState!=='credential_rotation_uncertain':polls!==1);attempt++)await delay(25);
   const saved=await client.store.load(connection.connection_id);assert.equal(rotations,1);
   if(lost){assert.equal(client.monitorState,'credential_rotation_uncertain');assert.equal(saved.rotation_pending,true);await client.disconnect();await assert.rejects(()=>client.connect({connection_id:connection.connection_id}),{code:'credential_rotation_uncertain'});}
   else{assert.equal(saved.credential,'c'.repeat(43));assert.equal(saved.rotation_pending,false);assert.equal(polls,1);assert.equal(client.monitorState,'running');}
  }finally{await client?.disconnect();await fs.rm(path.dirname(root),{recursive:true,force:true});}
 }
});
test('durable staged inbox survives reconnect without consuming on wake; writes run during long poll',async()=>{
 const root=path.join(await fs.mkdtemp(path.join(tmpdir(),'cowork-central-')),'private');
 const store=new ConnectionStore(root),calls=[],wakes=[];let offered=false;
 const event={seq:1,event_id:'event',kind:'postMessage',resource:{kind:'message',id:'message'},at:new Date().toISOString()};
 const fetchFn=async(url,options)=>{
  calls.push({url,options});
  assert.equal(options.redirect,'error');assert.ok(url.startsWith(origin));
  if(url.endsWith('/exchange'))return json(accepted);
  if(url.endsWith('/session'))return json({room:{id:'room'}});
  if(url.includes('/events')){
   if(!offered){offered=true;return json({events:[event],cursor:1,has_more:false});}
   await delay(100000,undefined,{signal:options.signal});
  }
  if(url.endsWith('/messages/message'))return json({id:'message',author:{id:'human'},text:'Hello',at:event.at});
  if(url.endsWith('/ack'))return json({acknowledged:['event']});
  if(url.endsWith('/messages'))return json({result:{status:'committed',data:{id:'outgoing'}}});
  throw Error('unexpected endpoint');
 };
 const client=new CentralClient({store,fetchFn,onEvent:event=>wakes.push(event)});
 try{
  const connected=await client.connect({invite,as_agent:'Agent'});
  for(let attempt=0;attempt<400&&!wakes.length;attempt++)await delay(25);
  assert.equal(wakes.length,1);assert.ok(!JSON.stringify(wakes).includes('Hello'));
  const saved=await store.load(connected.connection_id);assert.equal(saved.cursor,1);assert.equal(saved.staged.length,1);
  if(process.platform!=='win32')assert.equal((await fs.stat(store.file(connected.connection_id))).mode&0o777,0o600);
  assert.equal(calls.some(call=>call.url.endsWith('/ack')),false);
  const tools=centralTools(client);assert.deepEqual(await tools.find(tool=>tool.name==='ac_message').execute({text:'Outgoing'}),{sent:true,wire_id:'outgoing'});
  await client.disconnect();
  const restarted=new CentralClient({store,fetchFn});await restarted.connect({connection_id:connected.connection_id});
  assert.equal((await restarted.wait(1000)).status,'event');
  const messages=await restarted.messages();assert.equal(messages.messages[0].text,'Hello');assert.equal((await store.load(connected.connection_id)).staged.length,0);
  const abort=new AbortController(),pending=restarted.wait(50000,abort.signal);abort.abort();assert.equal((await pending).status,'cancelled');
  await restarted.disconnect();
  assert.ok(!JSON.stringify(client.publicRow()).includes(accepted.credential));
 }finally{await client.disconnect();await fs.rm(path.dirname(root),{recursive:true,force:true});}
});
test('connection store rejects symlinks and concurrent leases',async()=>{
 const root=path.join(await fs.mkdtemp(path.join(tmpdir(),'cowork-state-')),'private');
 const id='11111111-1111-1111-1111-111111111111',first=new ConnectionStore(root),second=new ConnectionStore(root);
 try{
  await first.acquire(id);await assert.rejects(()=>second.acquire(id),{code:'connection_in_use'});await first.release(id);
  await fs.writeFile(first.file(id)+'.lease',JSON.stringify({pid:2147483647,nonce:'stale'}),{mode:0o600});
  const recovered=await Promise.allSettled([first.acquire(id),second.acquire(id)]);
  assert.equal(recovered.filter(result=>result.status==='fulfilled').length,1);
  await first.release(id);await second.release(id);
  if(process.platform!=='win32'){await fs.symlink('/dev/null',first.file(id));await assert.rejects(()=>first.load(id));}
  const linked=path.join(root,'linked');await fs.symlink(root,linked,process.platform==='win32'?'junction':'dir');await assert.rejects(()=>new ConnectionStore(path.join(linked,'state')).init(),{code:'unsafe_state_directory'});
 }finally{await fs.rm(path.dirname(root),{recursive:true,force:true});}
});
test('file consumption before polling and interrupted acknowledgement reconcile durably',async()=>{
 const root=path.join(await fs.mkdtemp(path.join(tmpdir(),'cowork-files-')),'private');
 const store=new ConnectionStore(root),acknowledged=[];
 const event={seq:1,event_id:'file-event',kind:'attachment',resource:{kind:'attachment',id:'file'}};
 let releasePage,failAck=true;
 const page=new Promise(resolve=>{releasePage=resolve;});
 const fetchFn=async(url,options)=>{
  if(url.endsWith('/exchange'))return json(accepted);
  if(url.endsWith('/session'))return json({});
  if(url.includes('/events?after=0')){await page;return json({events:[event],cursor:1});}
  if(url.includes('/events'))await delay(100000,undefined,{signal:options.signal});
  if(url.endsWith('/files'))return json({files:[{id:'file',attachment:{filename:'test.txt',mime:'text/plain',size:1,hash:'hash'}}]});
  if(url.endsWith('/files/file'))return json({id:'file',attachment:{filename:'test.txt',mime:'text/plain',size:1,hash:'hash'}});
  if(url.endsWith('/ack')){
   if(failAck)throw Error('response lost');
   acknowledged.push(...JSON.parse(options.body).event_ids);return json({});
  }
  throw Error('unexpected endpoint');
 };
 const client=new CentralClient({store,fetchFn});let restarted;
 try{
  const connection=await client.connect({invite});
  assert.equal((await client.files({wire_ids:['file']})).files.length,1);
  assert.deepEqual((await store.load(connection.connection_id)).consumed_files,['file']);
  releasePage();
  for(let attempt=0;attempt<400&&!client.row.staged.length;attempt++)await delay(25);
  assert.equal(client.row.staged.length,1);
  await client.disconnect();failAck=false;
  restarted=new CentralClient({store,fetchFn});await restarted.connect({connection_id:connection.connection_id});
  for(let attempt=0;attempt<400&&restarted.row.staged.length;attempt++)await delay(25);
  assert.equal(restarted.row.staged.length,0);
  assert.deepEqual(acknowledged,['file-event']);
  assert.deepEqual((await restarted.files()).incoming,[]);
 }finally{releasePage();await client.disconnect();await restarted?.disconnect();await fs.rm(path.dirname(root),{recursive:true,force:true});}
});
test('unavailable commands do not block mail and uncertain sends reuse durable keys',async()=>{
 const root=path.join(await fs.mkdtemp(path.join(tmpdir(),'cowork-retry-')),'private');
 const store=new ConnectionStore(root),keys=[];let failSend=true;
 const fetchFn=async(url,options)=>{
  if(url.endsWith('/exchange'))return json(accepted);
  if(url.endsWith('/session'))return json({});
  if(url.includes('/events'))await delay(100000,undefined,{signal:options.signal});
  if(url.endsWith('/commands/old'))return new Response(JSON.stringify({error:{code:'result_visibility_changed'}}),{status:409});
  if(url.endsWith('/messages/new'))return json({id:'new',text:'Allowed',author:{id:'human'}});
  if(url.endsWith('/ack'))return json({});
  if(url.endsWith('/messages')){keys.push(JSON.parse(options.body).idempotency_key);if(failSend)throw Error('lost response');return json({sent:true});}
  throw Error('unexpected endpoint');
 };
 let client=new CentralClient({store,fetchFn});
 try{
  const connection=await client.connect({invite});
  await client.update(row=>{row.staged=[{event_id:'old-event',resource:{kind:'command',id:'old'}},{event_id:'new-event',resource:{kind:'message',id:'new'}}];});
  const result=await client.messages();assert.equal(result.messages[0].message_kind,'unavailable');assert.equal(result.messages[1].text,'Allowed');assert.equal(client.row.staged.length,0);
  await assert.rejects(()=>client.mutation('/messages',{body:{text:'Once'}}),error=>error.code==='central_unavailable'&&error.operation_id===keys[0]);
  await client.disconnect();client=new CentralClient({store,fetchFn});await client.connect({connection_id:connection.connection_id});failSend=false;
  await client.mutation('/messages',{body:{text:'Once'}});assert.equal(keys[0],keys[1]);assert.deepEqual(client.row.pending_operations,{});
 }finally{await client.disconnect();await fs.rm(path.dirname(root),{recursive:true,force:true});}
});
