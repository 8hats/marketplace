import test from 'node:test';
import assert from 'node:assert/strict';
import {CentralClient as PersonalClient} from '../src/central-client.mjs';
import {createRuntime as personalRuntime} from '../src/server.mjs';
import {CentralClient as ModeratorClient} from '../../au-cowork-moderator/src/central-client.mjs';
import {createRuntime as moderatorRuntime} from '../../au-cowork-moderator/src/server.mjs';

const origin='https://cowork.example',token='a'.repeat(43),credential='b'.repeat(43);
for(const [profile,Client,createRuntime] of [['personal',PersonalClient,personalRuntime],['moderator',ModeratorClient,moderatorRuntime]]){
 for(const tool of ['enter_room','connect_to_room']){
  for(const mode of ['lost','invalid-json','malformed','lease','storage','edge-429','edge-503']){
   test(`${profile}/${tool}: ${mode} uncertainty is non-retryable, sanitized and attempts one exchange`,async()=>{
    let requests=0,releases=0;
    const store={root:'/fixture',init:async()=>{},list:async()=>[],acquire:async()=>{if(mode==='lease')throw Error('lease failed');},save:async()=>{if(mode==='storage')throw Error('write failed');},release:async()=>{releases++;}};
    const client=new Client({origin,store,fetchFn:async(url,options)=>{
     requests++;assert.equal(new URL(url).pathname,'/api/v1/agent/exchange');assert.equal(options.method,'POST');
     if(mode==='lost')throw Error(token);
     if(mode==='invalid-json')return new Response('not JSON');
     if(mode.startsWith('edge-'))return new Response('<html>Upstream unavailable</html>',{status:Number(mode.slice(5)),headers:{'content-type':'text/html'}});
     return new Response(JSON.stringify({data:mode==='malformed'?{}:{credential,room_id:'room',agent_id:'agent',display_name:'Backend chosen'}}),{headers:{'content-type':'application/json'}});
    }});
    const handlers=new Map(),runtime=await createRuntime({client,injectedServer:{registerTool:(name,descriptor,handler)=>handlers.set(name,handler)}});
    try{
     const result=await handlers.get(tool)({invite:origin+'/agent-instructions#token='+token,...(tool==='enter_room'?{as_agent:'Submitted name'}:{})});
     assert.equal(result.isError,true);assert.equal(result.structuredContent.error.retryable,false);
     assert.match(result.structuredContent.error.message,/Do not retry.*inspect membership/);
     assert.equal(requests,1);assert.equal(client.row,null);assert.equal(releases,mode==='storage'?1:0);
     assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes(credential));
    }finally{await runtime.shutdown();}
   });
  }
 }
}
