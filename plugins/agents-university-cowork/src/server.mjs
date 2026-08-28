#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CoworkSession } from './session.mjs';
import { RoomRegistry } from './registry.mjs';
import { MonitorManager } from './monitor-manager.mjs';
import { parseRoomEnvelope } from './mcp/envelope.mjs';

export const VERSION = '1.0.0';
const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const ok = (data) => text({ ok: true, data, request_id: randomUUID() });
const fail = (code, message, retryable = false, action) => text({ ok: false, error: { code, message, retryable, ...(action ? { action } : {}) }, request_id: randomUUID() });
const operation = () => randomUUID();
const identityTaken = (error) => /exists|taken|duplicate/i.test(error?.message ?? '');
const PUBLIC_CODES = new Set(['session_already_bound', 'human_identity_required', 'identity_name_taken', 'room_name_conflict', 'room_not_found', 'identity_in_use', 'room_contact_missing', 'not_connected', 'room_not_ready', 'message_not_found', 'file_not_found', 'file_unreadable', 'file_too_large', 'daemon_unavailable']);
const SDK_CODES = new Map([
  ['NAME_TAKEN', 'identity_name_taken'], ['BOUND_ELSEWHERE', 'identity_in_use'], ['TEMP_OWNED_ELSEWHERE', 'identity_in_use'],
  ['FILE_UNREADABLE', 'file_unreadable'], ['PATH_NOT_ABSOLUTE', 'file_unreadable'], ['FILE_TOO_LARGE', 'file_too_large'],
  ['NOT_BOUND', 'not_connected'], ['NOT_BOUND_NO_NAME', 'not_connected'], ['NO_SUCH_IDENTITY', 'room_not_found'],
  ['UNKNOWN_OR_STALE_ID', 'file_not_found'], ['MALFORMED_ID', 'file_not_found']
]);
const daemonFailure = (error) => error?.name === 'DaemonUnavailableError' || ['ECONNREFUSED', 'ECONNRESET', 'ENOENT'].includes(error?.code) || /fetch failed|daemon.*unavailable|connect ECONN/i.test(error?.message ?? '');
const uploadTooLarge = (error) => /uploadFile\([^)]*\): upload is \d+ bytes, at or over the transport's \d+-byte envelope budget/i.test(error?.message ?? '');

export async function createRuntime({ session = new CoworkSession(), server: injectedServer, registry: injectedRegistry } = {}) {
  const registry = injectedRegistry ?? new RoomRegistry(session.selection.expectStateDir);
  await registry.init();
  await registry.list();
  const server = injectedServer ?? new McpServer({ name: 'agents-university-cowork', version: VERSION }, { capabilities: { logging: {} }, instructions: 'Bind one Cowork room; valid live wakes should be followed by the matching room read tool.' });
  const monitor = new MonitorManager({ server, registry });

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
    return ready && row.membership_state !== 'ready' ? registry.updateState(row.room_name, 'ready') : row;
  };
  const handler = (fn) => async (args) => {
    try { return await fn(args ?? {}); }
    catch (error) {
      const candidate = SDK_CODES.get(error?.code) ?? (PUBLIC_CODES.has(error?.code) ? error.code : uploadTooLarge(error) ? 'file_too_large' : daemonFailure(error) ? 'daemon_unavailable' : 'internal_error');
      const code = PUBLIC_CODES.has(candidate) ? candidate : 'internal_error';
      const message = code === 'daemon_unavailable' ? 'The shared ours daemon is unavailable; ask the operator to start it, then retry.'
        : code === 'file_unreadable' ? 'The file cannot be read by this process. Check the path and permissions, then retry.'
          : code === 'file_too_large' ? 'The file exceeds the ours transport limit.'
            : code === 'internal_error' ? 'Cowork could not complete the operation; use request_id for diagnostics.' : code;
      return fail(code, message, code === 'daemon_unavailable');
    }
  };
  const register = (name, description, inputSchema, fn, readOnly = false) => server.registerTool(name, {
    description, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false }
  }, handler(fn));

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
      return ok({ room_name: row.room_name, as_agent, status: ready ? 'connected' : 'connecting' });
    } catch (error) {
      if (contact) await client.removeContact({ contact: contact.cid }).catch(() => undefined);
      await client.removeIdentity({ name: as_agent }).catch(() => undefined);
      throw error;
    }
  });

  register('connect_to_room', 'Reconnect this session to a plugin-owned persistent room.', { room_name: z.string().min(1).max(256) }, async ({ room_name }) => {
    if (bound()) throw Object.assign(new Error('session_already_bound'), { code: 'session_already_bound' });
    let row = await registry.get(room_name); if (!row) throw Object.assign(new Error('room_not_found'), { code: 'room_not_found' });
    const client = await session.ensureAttached();
    try { await client.chooseIdentity({ name: row.identity_name, force: false }); }
    catch (error) { if (error?.code === 'BOUND_ELSEWHERE' || /bound|lease|use/i.test(error?.message ?? '')) throw Object.assign(new Error('identity_in_use'), { code: 'identity_in_use' }); throw error; }
    try {
      const contacts = await client.listContacts();
      const known = [...(contacts.contacts ?? []), ...(contacts.pending ?? [])].some((c) => (c.container_id ?? c.cid) === row.contact_cid);
      if (!known) throw Object.assign(new Error('room_contact_missing'), { code: 'room_contact_missing' });
      row = await liveReady(client, row); session.bound = row; monitor.start(client, row);
      return ok({ room_name: row.room_name, as_agent: row.identity_name, status: row.membership_state === 'ready' ? 'connected' : 'connecting' });
    } catch (error) { await session.release(); throw error; }
  });

  register('disconnect_from_room', 'Disconnect this session without deleting persistent room state.', {}, async () => {
    const row = bound(); monitor.stop(); await session.release();
    return ok({ ...(row ? { room_name: row.room_name } : {}), status: 'disconnected', ...(row ? {} : { already_disconnected: true }) });
  });

  register('list_rooms', 'List only rooms created by this plugin.', {}, async () => {
    const rows = await registry.list(); const identities = await (await session.ensureAttached()).listIdentities(); const sessions = identitySessions(identities);
    return ok({ rooms: rows.map((row) => publicRoom(row, sessions)) });
  }, true);

  register('get_room_status', 'Return the current session room state.', {}, async () => {
    let row = requireBound(); const client = await session.ensureAttached(); row = await liveReady(client, row); session.bound = row;
    const sessions = identitySessions(await client.listIdentities());
    return ok({ ...publicRoom(row, sessions), can_send: row.membership_state === 'ready', can_read: true, monitoring: 'armed' });
  });

  register('send_room_message', 'Send text to the bound room.', { text: z.string().min(1).max(100000) }, async ({ text: body }) => {
    const row = requireBound(); if (row.membership_state !== 'ready') throw Object.assign(new Error('room_not_ready'), { code: 'room_not_ready' });
    const outcome = await (await session.ensureAttached()).sendMessage({ contact: row.contact_cid, text: body });
    return ok({ operation_id: operation(), outcome: outcome.kind, history_stored: outcome.history_stored ?? null, warnings: [] });
  });

  register('read_room_messages', 'Drain the oldest unread room messages and hide non-room content.', { limit: z.number().int().min(1).max(200).optional() }, async ({ limit = 50 }) => {
    const row = requireBound(); const payload = await (await session.ensureAttached()).getMessages({ limit }); const messages = [];
    for (const item of payload.messages) {
      if (item.from?.id !== row.contact_cid) continue; const envelope = parseRoomEnvelope(item.body ?? item.text, row.room_name);
      if (!envelope || envelope.kind !== 'room_msg') continue;
      messages.push({ message_id: envelope.message_id, author: envelope.author, text: envelope.text, time: envelope.at ?? item.date, kind: envelope.kind });
    }
    return ok({ messages, remaining: payload.remaining });
  });

  register('reply_to_room_message', 'Reply to a room message still available in SDK history.', { message_id: z.string().min(1), text: z.string().min(1).max(100000) }, async ({ message_id, text: body }) => {
    const row = requireBound(); const client = await session.ensureAttached(); let cursor; let target;
    do { const page = await client.listHistory({ peer_cid: row.contact_cid, direction: 'in', before_seq: cursor, limit: 200 });
      target = page.items.find((item) => parseRoomEnvelope(item.body ?? item.text, row.room_name)?.message_id === message_id); cursor = page.next_cursor;
    } while (!target && cursor);
    if (!target) throw Object.assign(new Error('message_not_found'), { code: 'message_not_found' });
    const outcome = await client.sendMessage({ contact: row.contact_cid, text: body, reply_to_wire_id: target.wire_id });
    return ok({ message_id: operation(), reply_to: message_id, outcome: outcome.kind, warnings: [] });
  });

  register('send_room_file', 'Send one file to the bound room; text captions are separate messages.', { path: z.string().min(1) }, async ({ path: source }) => {
    const row = requireBound(); if (row.membership_state !== 'ready') throw Object.assign(new Error('room_not_ready'), { code: 'room_not_ready' });
    let bytes; try { bytes = await fs.readFile(source); } catch { throw Object.assign(new Error('file_unreadable'), { code: 'file_unreadable' }); }
    const client = await session.ensureAttached();
    const upload = await client.uploadFile(bytes, { filename: path.basename(source), size: bytes.byteLength });
    const outcome = await client.sendFile({ contact: row.contact_cid, upload_id: upload.upload_id, filename: upload.filename, mime: upload.mime });
    return ok({ operation_id: operation(), outcome: outcome.kind, warnings: [] });
  });

  register('read_room_files', 'Drain unread SDK-managed room files; author attribution is intentionally omitted.', { limit: z.number().int().min(1).max(200).optional() }, async ({ limit = 50 }) => {
    const row = requireBound(); const payload = await (await session.ensureAttached()).getFiles({ limit });
    const files = await Promise.all(payload.files.filter((f) => f.from?.id === row.contact_cid).map(async (f) => {
      const accessible = f.path ? await Promise.all([fs.access(f.path, constants.R_OK), fs.stat(f.path)]).then(([, stat]) => stat.isFile(), () => false) : false;
      return { file_id: f.wire_id, filename: f.filename, mime: f.mime, size: f.size, time: f.date, sdk_file_ref: accessible ? f.path : f.wire_id, availability: accessible ? 'available' : f.path ? 'unavailable' : 'metadata_only' };
    }));
    return ok({ files, remaining: payload.remaining });
  });

  return { server, session, registry, monitor, shutdown: async () => { monitor.stop(); await session.release(); } };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const runtime = await createRuntime().catch(async (error) => {
    const fallback = new McpServer({ name: 'agents-university-cowork', version: VERSION }, { instructions: 'Cowork is unavailable. Ask the operator to verify that the shared ours daemon is running, then retry.' });
    await fallback.connect(new StdioServerTransport()); return null;
  });
  if (runtime) {
    await runtime.server.connect(new StdioServerTransport());
    let closing = false; const close = async () => { if (closing) return; closing = true; await runtime.shutdown(); process.exitCode = 0; };
    process.stdin.once('end', close); process.stdin.once('close', close); process.once('SIGINT', close); process.once('SIGTERM', close);
  }
}
