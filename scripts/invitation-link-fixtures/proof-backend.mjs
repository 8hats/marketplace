// Explicit transport fixture, NOT the application backend or a test of its SQL/role policy.
import assert from 'node:assert/strict';
import https from 'node:https';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

export async function proofBackend(root){
 const ca=join(root,'ca.pem'),key=join(root,'server.key'),cert=join(root,'server.pem');
 const openssl=args=>execFileSync('openssl',args,{cwd:root,stdio:'pipe',timeout:15000});
 openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Cowork invitation test CA','-addext','basicConstraints=critical,CA:TRUE']);
 openssl(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=localhost']);
 await writeFile(join(root,'server.ext'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n',{mode:0o600});
 openssl(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','1','-extfile','server.ext']);
 const records=[],identities=new Map(),members=new Set(),errors=[];
 const server=https.createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
  const reply=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({data}));};
  try{
   const url=new URL(req.url,'https://localhost'),route=url.pathname;
   if(route==='/__proof'){reply({exchangeCount:records.length,membershipCount:members.size,records,errors});return;}
   assert.ok(route.startsWith('/api/v1/agent/'));assert.equal(url.hash,'');
   let input;if(req.method==='POST'){const chunks=[];for await(const chunk of req){chunks.push(chunk);assert.ok(Buffer.concat(chunks).length<16384);}input=JSON.parse(Buffer.concat(chunks).toString());}
   if(route==='/api/v1/agent/exchange'){
    assert.equal(req.method,'POST');assert.equal(req.headers.authorization,undefined);assert.equal(url.search,'');
    assert.deepEqual(Object.keys(input).sort(),['display_name','token']);assert.match(input.token,/^[A-Za-z0-9_-]{43}$/);
    records.push({token:input.token,display_name:input.display_name});
    if(input.token==='E'.repeat(43)){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'expired'}}));return;}
    members.add(input.token);
    if(input.token==='L'.repeat(43)){req.socket.destroy();return;}
    if(input.token==='M'.repeat(43)){res.writeHead(200,{'content-type':'application/json'});res.end('{malformed');return;}
    const credential=createHash('sha256').update(input.token).digest('base64url');
    const row={credential,room_id:'proof-room',room_name:'Proof room',agent_id:'proof-'+members.size,display_name:'Backend chosen name',expires_at:'2099-01-01T00:00:00.000Z'};
    identities.set(credential,row);reply(row);return;
   }
   const identity=identities.get(req.headers.authorization?.replace(/^Bearer /,''));assert.ok(identity,'Expected privately persisted credential on authenticated request');
   if(route==='/api/v1/agent/session'){reply({room:{id:'proof-room',name:'Proof room'},agent:{id:identity.agent_id,display_name:identity.display_name},capabilities:{proof:'capabilities'}});return;}
   if(route==='/api/v1/agent/events'){
    const timer=setTimeout(()=>reply({events:[],cursor:0}),100);res.once('close',()=>clearTimeout(timer));return;
   }
   if(route==='/api/v1/agent/commands'){
    assert.equal(input.command,'consumer.ac.read');assert.ok(['context','capabilities'].includes(input.arguments.kind));
    reply({result:{status:'ok',data:{proof:input.arguments.kind,agent_name:identity.display_name}}});return;
   }
   assert.fail('Unexpected proof-backend route');
  }catch(error){errors.push(error.code??error.name);if(!res.headersSent)reply({fixture_error:'assertion_failed'},500);else res.destroy();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {origin:'https://127.0.0.1:'+server.address().port,ca,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},snapshot:()=>({exchangeCount:records.length,membershipCount:members.size,errors})};
}
