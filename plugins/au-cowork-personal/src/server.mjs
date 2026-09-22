#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {connectionBootstrap} from './bootstrap.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {ForegroundWait,waitSchema,waitDescriptor,waitResult,monitorInstructions} from './foreground-wait.mjs';
import {createProductTools} from './product-tools.mjs';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {ConnectionRegistry,connectionView} from './connections.mjs';
import { connectInvite, reconnectInvite, markReady } from './invite-session.mjs';
import { remoteDiagnostic, remoteSetupInstructions } from './remote-config.mjs';
import { sessionRegistry } from './session-registries.mjs';
import { CoworkSession } from './session.mjs';
import { RoomRegistry } from './registry.mjs';
import { MonitorManager } from './monitor-manager.mjs';

export const VERSION = '1.3.3';
const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const ok = (data) => text({ ok: true, data, request_id: randomUUID() });
const fail = (code, message, retryable = false, action) => text({ ok: false, error: { code, message, retryable, ...(action ? { action } : {}) }, request_id: randomUUID() });
const identityTaken = (error) => /exists|taken|duplicate/i.test(error?.message ?? '');
const PUBLIC_CODES = new Set(['connection_not_found','connection_outcome_unresolved','connection_selection_required','connection_registry_unavailable','connection_registry_unsafe','connection_registry_corrupt','identity_mismatch','invite_already_attempted', 'invalid_request', 'session_already_bound', 'human_identity_required', 'identity_name_taken', 'room_name_conflict', 'room_not_found', 'identity_in_use', 'room_contact_missing', 'not_connected', 'room_not_ready', 'message_not_found', 'file_not_found', 'file_unreadable', 'file_too_large', 'daemon_unavailable']);
const SDK_CODES = new Map([
  ['NAME_TAKEN', 'identity_name_taken'], ['BOUND_ELSEWHERE', 'identity_in_use'], ['TEMP_OWNED_ELSEWHERE', 'identity_in_use'],
  ['FILE_UNREADABLE', 'file_unreadable'], ['PATH_NOT_ABSOLUTE', 'file_unreadable'], ['FILE_TOO_LARGE', 'file_too_large'],
  ['NOT_BOUND', 'not_connected'], ['NOT_BOUND_NO_NAME', 'not_connected'], ['NO_SUCH_IDENTITY', 'room_not_found'],
  ['UNKNOWN_OR_STALE_ID', 'file_not_found'], ['MALFORMED_ID', 'file_not_found']
]);
const daemonFailure = (error) => error?.name === 'DaemonUnavailableError' || ['ECONNREFUSED', 'ECONNRESET', 'ENOENT'].includes(error?.code) || /fetch failed|daemon.*unavailable|connect ECONN/i.test(error?.message ?? '');
const uploadTooLarge = (error) => /uploadFile\([^)]*\): upload is \d+ bytes, at or over the transport's \d+-byte envelope budget/i.test(error?.message ?? '');

export async function createRuntime({ session = new CoworkSession(), server: injectedServer, registry: injectedRegistry, connections: injectedConnections, productOptions } = {}) {
  const connections=injectedConnections??session.connections??sessionRegistry(session,ConnectionRegistry,['init','list','get','reserve','update','attempted']);session.connections=connections;
  const registry=injectedRegistry??sessionRegistry(session,RoomRegistry,['init','list','get','create','updateState']);
  if(injectedRegistry){await registry.init();await registry.list();}
  const server = injectedServer ?? new McpServer({ name: 'au-cowork-personal', version: VERSION }, { capabilities: { logging: {} }, instructions: remoteSetupInstructions+"\n"+monitorInstructions });
  const monitor = new MonitorManager({ server, registry });

  const product = createProductTools(session,{...productOptions,profile:'personal',onRetainedMessage:(row,item)=>monitor.wakeRetained(row,item)});
  const definitions=[waitDescriptor];let busy=false;
  const waiter=new ForegroundWait({session,monitor,retained:()=>product.retainedMessages()});
  server.registerTool(waitDescriptor.name,{description:waitDescriptor.description,inputSchema:waitSchema.shape},async(args,extra)=>waitResult(await waiter.wait(waitSchema.parse(args),extra?.signal)));
  const exclusive=fn=>async args=>{if(busy)return {isError:true,content:[{type:'text',text:JSON.stringify({code:'invalid_state',effect:'none',message:'Another room tool is active.'})}]};busy=true;try{return await fn(args);}finally{busy=false;}};
  const bound = () => session.bound;
  const identitySessions = (identities) => new Map(identities.filter((item) => 'session' in item).map((item) => [item.name, item.session]));
  const publicRoom = (row, sessions) => {
    const sessionState = sessions.get(row.identity_name) ?? null;
    const bindState = sessionState === 'mine' ? 'bound_here' : sessionState === 'other-live' ? 'bound_elsewhere' : 'unbound';
    const status = row.membership_state === 'connecting' ? 'connecting' : bindState === 'bound_here' ? 'connected' : 'disconnected';
    return { room_name: row.room_name, as_agent: row.identity_name, status, membership_state: row.membership_state, bind_state: bindState };
  };
  const requireBound = () => { const row = bound(); if (!row) throw Object.assign(new Error('not_connected'), { code: 'not_connected' }); return row; };
  const liveReady = async (client, row) => {
    const contacts = await client.listContacts();
    const ready = contacts.contacts?.some((c) => c.container_id === row.contact_cid);
    return ready && row.membership_state !== 'ready' ? markReady(registry, row) : row;
  };
  const handler = (fn) => async (args) => {
    try { return await fn(args ?? {}); }
    catch (error) {
      const remote=remoteDiagnostic(error);if(remote){const result=fail(remote.code,remote.message,['remote_unavailable','daemon_setup_required'].includes(remote.code));if(error.connection_id){Object.assign(result.structuredContent.error,{connection_id:error.connection_id,identity_name:error.identity_name,identity_retained:error.identity_retained});return text(result.structuredContent);}return result;}
      const candidate = SDK_CODES.get(error?.code) ?? (PUBLIC_CODES.has(error?.code) ? error.code : uploadTooLarge(error) ? 'file_too_large' : daemonFailure(error) ? 'daemon_unavailable' : 'internal_error');
      const code = PUBLIC_CODES.has(candidate) ? candidate : 'internal_error';
      const message = code === 'daemon_unavailable' ? 'The shared ours daemon is unavailable; ask the operator to start it, then retry.'
        : code === 'file_unreadable' ? 'The file cannot be read by this process. Check the path and permissions, then retry.'
          : code === 'file_too_large' ? 'The file exceeds the ours transport limit.'
            : code === 'invite_already_attempted' ? 'This invite was already used for a redemption attempt. Reconnect with its connection_id instead; a reserve that never reached the daemon releases the invite automatically after 30 seconds.'
              : code === 'internal_error' ? 'Cowork could not complete the operation; use request_id for diagnostics.' : code;
      const result=fail(code,message,code==='daemon_unavailable');if(error.connection_id){const value=JSON.parse(result.content[0].text);value.error.connection_id=error.connection_id;value.error.identity_name=error.identity_name;value.error.identity_retained=error.identity_retained;return text(value);}return result;
    }
  };
  const register = (name, description, inputSchema, fn, readOnly = false) => { definitions.push({name,description,inputSchema:z.object(inputSchema)});return server.registerTool(name, {
    description, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false }
  }, exclusive(handler(fn))); };

  register('enter_room', 'Enter a Cowork room from an invite as a persistent exact agent identity.', {
    invite: z.string().min(1), as_agent: z.string().min(1).max(128)
  }, async ({ invite, as_agent }) => {
    if (bound()) throw Object.assign(new Error('session_already_bound'), { code: 'session_already_bound' });
    const client = await session.ensureAttached();
    const identities = await client.listIdentities();
    if (!identities.some((row) => row.kind === 'root')) throw Object.assign(new Error('human_identity_required'), { code: 'human_identity_required' });
    try { await client.createIdentity({ name: as_agent, bio: `Cowork room identity: ${as_agent}`, exposeLocal: false, localAutoAccept: false }); }
    catch (error) { if (error?.code === 'NAME_TAKEN' || identityTaken(error)) throw Object.assign(new Error('identity_name_taken'), { code: 'identity_name_taken' }); throw error; }
    let contact;
    try {
      contact = await client.addContact({ invite });
      const contacts = await client.listContacts();
      const ready = contacts.contacts?.some((c) => c.container_id === contact.cid);
      const row = await registry.create({ roomName: contact.display, identityName: as_agent, contactCid: contact.cid, membershipState: ready ? 'ready' : 'connecting' });
      session.bound = row; monitor.start(client, row);
      return ok({ room_name: row.room_name, as_agent, status: ready ? 'connected' : 'connecting', monitoring_instructions:remoteSetupInstructions+"\n"+monitorInstructions, bootstrap:connectionBootstrap() });
    } catch (error) {
      if (contact) await client.removeContact({ contact: contact.cid }).catch(() => undefined);
      await client.removeIdentity({ name: as_agent }).catch(() => undefined);
      throw error;
    }
  });

  register('connect_to_room', 'Create a unique persistent identity with an invite once, or reconnect the exact saved connection_id. room_name reconnect requires a unique match. Supply exactly one.', { invite: z.string().min(1).optional(), room_name: z.string().min(1).max(256).optional(), connection_id:z.string().uuid().optional() }, async ({ invite, room_name, connection_id }) => {
    if ([invite,room_name,connection_id].filter(Boolean).length!==1) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
    if(connection_id){const result=await reconnectInvite(session,connection_id,'personal');monitor.start(await session.ensureAttached(),session.bound);return ok(result);}
    if (invite) { const result = await connectInvite(session, invite, 'personal'); monitor.start(await session.ensureAttached(), session.bound); return ok(result); }
    if (bound()) throw Object.assign(new Error('session_already_bound'), { code: 'session_already_bound' });
    const matches=(await connections?.list('personal')??[]).filter(row=>row.room_name===room_name);
    const legacyRow=await registry.get(room_name);
    if(matches.length+(legacyRow?1:0)>1)throw Object.assign(new Error('connection_selection_required'),{code:'connection_selection_required'});
    if(matches.length===1){const result=await reconnectInvite(session,matches[0].connection_id,'personal');monitor.start(await session.ensureAttached(),session.bound);return ok(result);}
    let row = legacyRow; if (!row) throw Object.assign(new Error('room_not_found'), { code: 'room_not_found' });
    const client = await session.ensureAttached();
    try { await client.chooseIdentity({ name: row.identity_name, force: false }); }
    catch (error) { if (error?.code === 'BOUND_ELSEWHERE' || /bound|lease|use/i.test(error?.message ?? '')) throw Object.assign(new Error('identity_in_use'), { code: 'identity_in_use' }); throw error; }
    try {
      const contacts = await client.listContacts();
      const known = [...(contacts.contacts ?? []), ...(contacts.pending ?? [])].some((c) => (c.container_id ?? c.cid) === row.contact_cid);
      if (!known) throw Object.assign(new Error('room_contact_missing'), { code: 'room_contact_missing' });
      row = await liveReady(client, row); session.bound = row; monitor.start(client, row);
      return ok({ room_name: row.room_name, as_agent: row.identity_name, status: row.membership_state === 'ready' ? 'connected' : 'connecting', monitoring_instructions:remoteSetupInstructions+"\n"+monitorInstructions, bootstrap:connectionBootstrap() });
    } catch (error) { await session.release(); throw error; }
  });

  register('disconnect_from_room', 'Disconnect this session without deleting persistent room state.', {}, async () => {
    const row = bound(); monitor.stop(); await session.release();
    return ok({ ...(row ? { room_name: row.room_name } : {}), status: 'disconnected', ...(row ? {} : { already_disconnected: true }) });
  });

  register('list_rooms', 'List only rooms created by this plugin.', {}, async () => {
    const rows = await registry.list(); const identities = await (await session.ensureAttached()).listIdentities(); const sessions = identitySessions(identities);
    return ok({ rooms: [...rows.map((row) => publicRoom(row, sessions)),...(await connections?.list('personal')??[]).map(row=>({...connectionView(row),bind_state:sessions.get(row.identity_name)==='other-live'?'bound_elsewhere':sessions.get(row.identity_name)==='mine'?'bound_here':'unbound'}))] });
  }, true);

  register('get_room_status', 'Return the current session room state.', {}, async () => {
    let row = requireBound(); const client = await session.ensureAttached(); row = await liveReady(client, row); session.bound = row;
    const sessions = identitySessions(await client.listIdentities());
    return ok({ ...publicRoom(row, sessions), can_send: row.membership_state === 'ready', can_read: true, monitoring: 'armed', bootstrap:connectionBootstrap() });
  });

  for(const tool of product.descriptors.values()){
    definitions.push(tool);
    server.registerTool(tool.name,{description:tool.description,inputSchema:z.object({}).passthrough(),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},exclusive(args=>product.execute(tool.name,args)));
  }
  // Advertise full strict union/refinement schemas, while executors validate the
  // original Zod schema rather than a permissive MCP raw-shape conversion.
  if(server.server)server.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:definitions.map(tool=>({name:tool.name,description:tool.description,inputSchema:{...zodToJsonSchema(tool.inputSchema,{$refStrategy:'none'}),type:'object'}}))}));

  return { server, session, registry, monitor, shutdown: async () => { monitor.stop(); await session.release(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = await createRuntime().catch(async (error) => {
    const diagnostic=remoteDiagnostic(error)?.message??'Cowork is unavailable. Ask the operator to verify the daemon configuration and service.';
    process.stderr.write(diagnostic+'\n');
    const fallback = new McpServer({ name: 'au-cowork-personal', version: VERSION }, { instructions: diagnostic });
    await fallback.connect(new StdioServerTransport()); return null;
  });
  if (runtime) {
    await runtime.server.connect(new StdioServerTransport());
    let closing = false; const close = async () => { if (closing) return; closing = true; await runtime.shutdown(); process.exitCode = 0; };
    process.stdin.once('end', close); process.stdin.once('close', close); process.once('SIGINT', close); process.once('SIGTERM', close);
  }
}
