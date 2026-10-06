// Offline process fixture: never contacts a real room or exchanges an invite.
import {createRuntime,ConnectionStore} from '../src/server.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const runtime=await createRuntime({
 injectedServer:{registerTool(){},sendLoggingMessage:async()=>{}},
 clientOptions:{store:new ConnectionStore(process.argv[2]),fetchFn:async(url,options)=>{
  if(!url.includes('/events'))throw Error('Unexpected request during restoration');
  await delay(100000,undefined,{signal:options.signal});
 }},
});
process.send({connection_id:runtime.client.row?.connection_id,monitoring:runtime.client.monitorState,restore_error:runtime.client.restoreError?.code});
process.on('message',async message=>{if(message==='stop'){await runtime.shutdown();process.exit(0);}});
