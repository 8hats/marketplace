// Run with Node 22 and the matching Cowork checkout's tsx loader:
// node --import <cowork>/backend/node_modules/tsx/dist/loader.mjs scripts/inquiry-backend-check.mjs <cowork>
// Isolated real Application/SQLite/HTTPS agent routes; no deployed service or installed plugin.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:https';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(process.argv[2],'Provide the matching Cowork checkout explicitly');
const cowork=resolve(process.argv[2]);
const profiles=process.argv.slice(3);if(!profiles.length)profiles.push('personal','moderator');
assert.ok(profiles.every(profile=>['personal','moderator'].includes(profile)),'Unknown connector profile');
const source=async name=>import(pathToFileURL(join(cowork,`backend/src/${name}.ts`)));
const {Access}=await source('access');
const {Database}=await source('database');
const {Application}=await source('application');
const {configure}=await source('preview-configuration');
const {createAgentHandler}=await source('agent-http');
const require=createRequire(join(root,'plugins/au-cowork-personal/package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
const temporary=await mkdtemp(join(tmpdir(),'inquiry-backend-check-'));
let server,db,modules;
try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temporary,'key.pem'),'-out',join(temporary,'ca.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore',timeout:10000});
 let handler;
 server=createServer({key:await readFile(join(temporary,'key.pem')),cert:await readFile(join(temporary,'ca.pem'))},(req,res)=>{
  if(!handler||!req.url?.startsWith('/api/v1/agent/')){res.writeHead(404).end();return;}
  void handler(req,res);
 });
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 const origin=`https://127.0.0.1:${server.address().port}`;
 db=new Database(':memory:');
 const previous=process.env.AC_ORIGIN;process.env.AC_ORIGIN=origin;
 try{modules=await configure(db);}finally{if(previous===undefined)delete process.env.AC_ORIGIN;else process.env.AC_ORIGIN=previous;}
 db.sql.prepare('INSERT INTO humans(id,display_name) VALUES(?,?)').run('human','Isolated transport human');
 db.sql.prepare('INSERT INTO sessions(token_hash,human_id,csrf_token,expires_at) VALUES(?,?,?,?)').run('isolated-test-session','human','isolated-test-csrf','2099-01-01T00:00:00.000Z');
 const created=await modules.setup.createRoom({id:'human',display_name:'Isolated transport human'},{title:'Isolated transport proof',goal:'Verify lifecycle transport',criteria:[]});
 const app=new Application({...modules,db,origin});
 handler=createAgentHandler({db,application:app,credentials:modules.credentials,events:modules.events,files:modules.bridge,attachments:modules.attachments,conversation:modules.conversation});
 const backend={app};
 const ca=join(temporary,'ca.pem');
 const human=new Access(db).human('human',created.room.id,'rest');
 for(const profile of profiles){
  const plugin=join(root,`plugins/au-cowork-${profile}`);
  const pkg=JSON.parse(await readFile(join(plugin,'package.json'),'utf8'));
  assert.equal(pkg.version,'2.4.0');
  for(const manifest of ['.claude-plugin/plugin.json','.codex-plugin/plugin.json','package-lock.json'])assert.equal(JSON.parse(await readFile(join(plugin,manifest),'utf8')).version,pkg.version);
  const runtime=await readFile(join(plugin,'dist/cowork-mcp.mjs'));
  if(profile==='personal'){
   assert.equal(JSON.parse(await readFile(join(plugin,'harness/package.json'),'utf8')).version,pkg.version);
   assert.deepEqual(await readFile(join(plugin,'harness/dist/cowork-mcp.mjs')),runtime);
  }
  const invitation=await backend.app.operation('inviteAgent',human,{purpose:profile});
  const env={...process.env,AC_COWORK_HOME:join(temporary,profile),NODE_EXTRA_CA_CERTS:ca};
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;delete env.NODE_OPTIONS;
  const transport=new StdioClientTransport({command:process.execPath,args:[join(plugin,'dist/cowork-mcp.mjs')],env,stderr:'pipe'});
  // Never print child output: all invitations, credentials and local addresses stay private.
  transport.stderr?.resume();
  const client=new Client({name:'isolated-lifecycle-proof',version:'1'});
  try{
   await client.connect(transport);assert.equal(client.getServerVersion().version,pkg.version);
   const tools=(await client.listTools()).tools;assert.ok(tools.some(t=>t.name==='ac_inquiry_act'));
   const call=async(name,args)=>{
    const result=await client.callTool({name,arguments:args});
    assert.notEqual(result.isError,true,`${name} transport failed: ${result.structuredContent?.error?.code??'unknown'}`);
    return result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
   };
   await call('connect_to_room',{invite:invitation.invite_url});
   const committed=async(name,args)=>{const result=await call(name,args);assert.equal(result.status,'committed',`${name} rejected`);return result.data;};
   const q=await committed('ac_ask',{actor_id:'human',question:`${profile}: choose a direction`,audience:{kind:'room'}});
   assert.equal(q.lifecycle.turn,'recipient');assert.equal(q.lifecycle.revision,0);assert.deepEqual(q.allowed_actions,['resolve']);
   const read=async()=>{const result=await call('ac_read',{kind:'inquiry',id:q.id});assert.equal(result.status,'ok');return result.data;};
   assert.equal((await read()).lifecycle.revision,0);
   await backend.app.operation('actInquiry',human,{inquiry_id:q.id,expected_revision:0,idempotency_key:`${profile}-human-answer`,action:'reply',text:'Use the bounded option.'});
   const answered=await read();assert.equal(answered.state,'open');assert.equal(answered.lifecycle.turn,'requester');assert.equal(answered.lifecycle.revision,1);
   const follow={inquiry_id:q.id,expected_revision:1,idempotency_key:`${profile}-follow`,action:'reply',text:'Please confirm one detail.'};
   const followed=await committed('ac_inquiry_act',follow);assert.equal(followed.effective_action,'follow_up');assert.equal(followed.inquiry.lifecycle.turn,'recipient');assert.equal(followed.inquiry.lifecycle.revision,2);
   // The identical key is a replay, not another message or revision.
   const replay=await committed('ac_inquiry_act',follow);assert.equal(replay.inquiry.lifecycle.revision,2);
   await backend.app.operation('grantInquiryAgent',human,{agent_id:q.asked_by.id,enabled:true});
   const age=(await read()).lifecycle.turn_since;
   const progress=await committed('ac_inquiry_act',{inquiry_id:q.id,expected_revision:2,idempotency_key:`${profile}-progress`,action:'progress',text:'Checking the detail.'});
   assert.equal(progress.inquiry.lifecycle.turn,'recipient');assert.equal(progress.inquiry.lifecycle.turn_since,age);assert.equal(progress.inquiry.lifecycle.revision,3);
   const resolved=await committed('ac_inquiry_act',{inquiry_id:q.id,expected_revision:3,idempotency_key:`${profile}-resolve`,action:'resolve',text:'Decision recorded; question resolved.'});
   assert.equal(resolved.inquiry.state,'resolved');assert.deepEqual((await read()).allowed_actions,[]);
   await call('disconnect_from_room',{});
   console.log(JSON.stringify({profile,version:pkg.version,sha256:createHash('sha256').update(runtime).digest('hex'),checks:['built-stdio','real-https-sqlite','ask','canonical-read','human-answer-stays-open','agent-follow-up','idempotent-replay','granted-progress-retains-age','requester-resolve','closed-read']}));
  }finally{await client.close();await transport.close();}
 }
}finally{
 if(server?.listening){server.closeAllConnections();await new Promise((yes,no)=>server.close(error=>error?no(error):yes()));}
 await modules?.close();db?.close();
 // Only this script's verified, mkdtemp-created child directory is removed.
 assert.equal(dirname(temporary),tmpdir());assert.ok(temporary.startsWith(join(tmpdir(),'inquiry-backend-check-')));
 await rm(temporary,{recursive:true,force:true});
}
