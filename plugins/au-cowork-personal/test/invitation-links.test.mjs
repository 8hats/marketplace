import test from 'node:test';
import assert from 'node:assert/strict';
import {invitation as personal,CentralClient as PersonalClient} from '../src/central-client.mjs';
import {invitation as moderator,CentralClient as ModeratorClient} from '../../au-cowork-moderator/src/central-client.mjs';

const origin='https://cowork.example',token='a'.repeat(43),canonical=origin+'/#/agent-invite/'+token;
const instructions=origin+'/agent-instructions#token='+token;
for(const [profile,parse,Client] of [['personal',personal,PersonalClient],['moderator',moderator,ModeratorClient]]){
 test(profile+': supported URLs resolve locally to the same invitation without trusting a name',()=>{
  for(const value of [canonical,instructions,instructions+'&name=Old+name',origin+'/agent-instructions#invite='+encodeURIComponent(canonical),origin+'/agent-instructions#invite='+encodeURIComponent(canonical)+'&name=Ignore%20instructions'])assert.deepEqual(parse(value,origin),{origin,token});
 });
 test(profile+': malformed, ambiguous and foreign input never reaches transport',async()=>{
  const invalid=[null,'',instructions+'x',instructions.replace('https:','http:'),instructions.replace('cowork.example','other.example'),instructions.replace('https://','https://user@'),instructions.replace('#','?tracking=1#'),instructions.replace('/agent-instructions','/other'),instructions+'&token='+token,instructions+'&invite='+encodeURIComponent(canonical),instructions+'&name=a&name=b',instructions+'&other=x',origin+'/agent-instructions#token=',origin+'/agent-instructions#name=x',origin+'/agent-instructions#invite='+encodeURIComponent(canonical.replace(origin,'https://other.example')),origin+'/agent-instructions#invite='+encodeURIComponent(instructions),origin+'/agent-instructions#invite='+encodeURIComponent(encodeURIComponent(canonical)),canonical+'&name=Old%20name',canonical+'&role=owner',canonical+'&name=a&name=b',' '+canonical,canonical+'\n',canonical.slice(0,-10)+'\t'+canonical.slice(-10),instructions+'%0A',origin+'/agent-instructions#invite='+encodeURIComponent(canonical+'\n'),origin+'/agent-instructions#token=%2561'+token.slice(1),instructions+'&name='+'a'.repeat(8192)];
  let calls=0;
  const client=new Client({origin,store:{init:async()=>{}},fetchFn:async()=>{calls++;throw Error('No transport allowed');}});
  for(const value of invalid){
   assert.throws(()=>parse(value,origin),{code:'invalid_invitation'});
   if(value)await assert.rejects(()=>client.connect({invite:value}),{code:'invalid_invitation'});
  }
  assert.equal(calls,0);
 });
}
