import test from 'node:test';
import assert from 'node:assert/strict';
import {centralTools} from '../src/central-tools.mjs';
import {createRuntime} from '../src/server.mjs';

test('Moderator status tool is discoverable and sends only a fixed status through the bound client',async()=>{
 const calls=[],client={stopMonitoring:async()=>{},restoreMonitoring:async()=>{},disconnect:async()=>{},mutation:async(...args)=>{calls.push(args);return {result:{status:'committed',data:{status:'done',state:'open'}}};}};
 const tool=centralTools(client,'moderator').find(t=>t.name==='ac_room_status_set');assert.ok(tool);assert.match(tool.description,/Done keeps the room open and writable/);
 assert.ok(!centralTools(client,'personal').some(t=>t.name===tool.name));
 for(const input of [{status:'custom'},{status:'todo',room_id:'other'},{status:'Done'},{}])assert.equal(tool.inputSchema.safeParse(input).success,false);
 assert.deepEqual(await tool.execute(tool.inputSchema.parse({status:'done'})),{status:'committed',data:{status:'done',state:'open'}});
 assert.deepEqual(calls,[['/commands',{body:{command:'consumer.ac.room.status.set',arguments:{status:'done'}}}]]);
 const handlers=new Map();let list;
 const runtime=await createRuntime({client,profile:'moderator',injectedServer:{registerTool:(name,_descriptor,handler)=>handlers.set(name,handler),server:{setRequestHandler:(_schema,handler)=>list=handler}}});
 try{assert.ok((await list()).tools.some(t=>t.name===tool.name));const result=await handlers.get(tool.name)({status:'todo',room_id:'other'});assert.equal(result.isError,true);assert.equal(calls.length,1);}finally{await runtime.shutdown();}
});
