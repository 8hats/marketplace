// A real process with its own identity, lease, monitor, and durable inbox.
import {CentralClient,ConnectionStore} from '../src/central-client.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const [root,id]=process.argv.slice(2);
const store=new ConnectionStore(root);
const reply=data=>new Response(JSON.stringify({data}));
let delivered=false;
const client=new CentralClient({store,fetchFn:async(url,options)=>{
 if(url.endsWith('/session'))return reply({});
 if(url.includes('/events')){
  if(!delivered){delivered=true;return reply({events:[{event_id:id,seq:1,kind:'message',resource:{kind:'message',id}}],cursor:1});}
  await delay(100000,undefined,{signal:options.signal});
 }
 if(url.endsWith('/messages/'+id))return reply({id,author:{id},text:id});
 if(url.endsWith('/ack'))return reply({});
 throw Error('unexpected endpoint');
},onEvent:()=>process.send?.({event:true})});
process.on('message',async command=>{
 try{
  if(command==='read'){const result=await client.messages();process.send({read:result.messages.map(row=>row.text),cursor:client.row.cursor});}
  if(command==='stop'){await client.disconnect();process.send({stopped:true});process.disconnect();}
 }catch(error){process.send({error:error.code??'failure'});}
});
try{await client.connect({connection_id:id});process.send({connected:true});}
catch(error){process.send({error:error.code??'failure'});process.disconnect();}
