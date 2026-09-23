import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRemoteConfig, remoteTransport, attachRemote, remoteDiagnostic } from '../src/remote-config.mjs';

const secret='test-only-secret';
const environment={AU_OURS_URL:'https://daemon.example/gate/',AU_OURS_API_TOKEN:secret};
test('default selection leaves local SDK in charge without reading local credentials',()=>{
 assert.equal(resolveRemoteConfig({env:{},cwd:'/nonexistent-test-project'}),null);
});

test('SDK requests carry external ownership and server error prose is withheld',async()=>{
 const calls=[];const selection=resolveRemoteConfig({env:environment});
 const client=await attachRemote(selection,{leaseToken:'stable-owner',fetch:async(url,options)=>{
  calls.push({url,options});
  return url.endsWith('/info')?Response.json({name:'ours',version:'3.8.1-nightly.1'}):Response.json({error:{code:'NOT_BOUND',message:secret}},{status:400});
 }});
 await assert.rejects(client.currentIdentity(),e=>e.code==='NOT_BOUND'&&!e.message.includes(secret));
 assert.equal(calls[1].options.headers['x-ours-session-mode'],'external');assert.equal(calls[1].options.headers['x-ours-lease-token'],'stable-owner');assert.equal(calls[1].options.headers['x-ours-api-token'],secret);assert.equal(calls[1].options.redirect,'error');
});
test('explicit environment pair normalizes a prefix and overrides project config as a pair',()=>{
 const selected=resolveRemoteConfig({env:{...environment,AU_OURS_CONFIG:'/missing'},cwd:'/missing'});
 assert.equal(selected.url,'https://daemon.example/gate');
 assert.equal(selected.token(),secret);
 assert.equal(JSON.stringify(selected).includes(secret),false);
});
test('partial or empty environment pair cannot borrow project credentials',()=>{
 for(const env of [{AU_OURS_URL:environment.AU_OURS_URL},{AU_OURS_API_TOKEN:secret},{...environment,AU_OURS_API_TOKEN:''}]){
  assert.throws(()=>resolveRemoteConfig({env}),e=>e.code==='remote_configuration'&&!e.message.includes(secret));
 }
});
test('reject unsafe addresses without reflecting input',()=>{
 for(const url of ['http://example.com','https://user:password@example.com','https://example.com/?token=secret','https://example.com/#secret','https://example.com\\evil','file:///tmp/x','http://127.1',' https://example.com','https://example.com/%2e%2e/admin']){
  assert.throws(()=>resolveRemoteConfig({env:{...environment,AU_OURS_URL:url}}),e=>e.code==='remote_configuration'&&!e.message.includes(url));
 }
 for(const url of ['http://127.0.0.1:3070','http://[::1]:3070','https://example.com/prefix'])assert.ok(resolveRemoteConfig({env:{...environment,AU_OURS_URL:url}}));
});
test('project configuration uses protected token file and rejects unsafe permissions/malformed JSON',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'au-remote-'));
 try{
  const file=path.join(cwd,'.au-ours.json'),token=path.join(cwd,'token');
  fs.writeFileSync(token,secret,{mode:0o600});fs.writeFileSync(file,JSON.stringify({url:environment.AU_OURS_URL,tokenFile:'token'}));
  const selected=resolveRemoteConfig({env:{},cwd});assert.equal(selected.token(),secret);
  fs.writeFileSync(file,'{');assert.throws(()=>resolveRemoteConfig({env:{},cwd}),{code:'remote_configuration'});
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
// Split out and VISIBLY skipped rather than hidden behind an `if`: on Windows chmod cannot
// clear group/other bits, so this assertion can never hold there. A silent `if` made a Windows
// run report "passed" for a permission check it never made.
test('a token file with group/other permissions is rejected',{skip:process.platform==='win32'&&'chmod cannot clear group/other bits on Windows; stat always reports 0666'},()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'au-remote-'));
 try{
  const file=path.join(cwd,'.au-ours.json'),token=path.join(cwd,'token');
  fs.writeFileSync(token,secret,{mode:0o600});fs.writeFileSync(file,JSON.stringify({url:environment.AU_OURS_URL,tokenFile:'token'}));
  const selected=resolveRemoteConfig({env:{},cwd});assert.equal(selected.token(),secret);
  fs.chmodSync(token,0o644);assert.throws(()=>selected.token(),{code:'remote_configuration'});
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
test('a symlinked token file is rejected',{skip:process.platform==='win32'&&'creating a file symlink on Windows requires admin or Developer Mode'},()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'au-remote-'));
 try{
  const file=path.join(cwd,'.au-ours.json'),token=path.join(cwd,'token'),real=path.join(cwd,'real-secret');
  fs.writeFileSync(real,secret,{mode:0o600});fs.symlinkSync(real,token);
  fs.writeFileSync(file,JSON.stringify({url:environment.AU_OURS_URL,tokenFile:'token'}));
  assert.throws(()=>resolveRemoteConfig({env:{},cwd}).token(),{code:'remote_configuration'});
 }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
test('every request refuses redirects and cannot leave selected origin/path',async()=>{
 let seen;const fetch=remoteTransport('https://daemon.example/gate',async(url,options)=>{seen=options;return new Response('{}');});
 await fetch('https://daemon.example/gate/info',{redirect:'follow'});assert.equal(seen.redirect,'error');
 for(const url of ['https://elsewhere.example/info','https://daemon.example/other','https://daemon.example/gate/../info'])await assert.rejects(fetch(url),{code:'remote_configuration'});
});
test('authentication, transport and unsupported daemon failures are actionable and secret-safe',async()=>{
 const selection=resolveRemoteConfig({env:environment});
 for(const [fetch,code] of [[async()=>new Response(secret,{status:401}),'remote_authentication'],[async()=>{throw Error(secret);},'remote_unavailable'],[async()=>Response.json({name:'ours',version:'3.8.0'}),'remote_unsupported']]){
  await assert.rejects(attachRemote(selection,{leaseToken:'test-owner',fetch}),e=>e.code===code&&!e.message.includes(secret));
 }
});

test('a missing AU_OURS_CONFIG file names the resolved path it looked at', () => {
  // The value is resolved against the MCP server's cwd — the INSTALLED PLUGIN ROOT — so a relative
  // value, or an MSYS-style /c/Users/... on Windows, silently becomes a path inside the plugin
  // directory and the real file is never read. Without the resolved path this reads as "the daemon
  // is misconfigured" rather than "we disagree about which file that was". Cost one QA run a retry.
  let thrown;
  try { resolveRemoteConfig({ env: { AU_OURS_CONFIG: '/c/Users/you/au-ours.json' }, cwd: '/plugin/root' }); }
  catch (error) { thrown = error; }
  assert.ok(thrown, 'a missing explicit config file must throw');
  const surfaced = remoteDiagnostic(thrown);
  assert.equal(surfaced.code, 'remote_configuration');
  assert.match(surfaced.message, /\/c\/Users\/you\/au-ours\.json/, 'must echo the value that was given');
  assert.match(surfaced.message, /C:\/Users/, 'must show the Windows drive-letter form');
});
