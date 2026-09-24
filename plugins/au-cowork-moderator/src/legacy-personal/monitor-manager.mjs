import { markReady } from './invite-session.mjs';
import { parseRoomEnvelope } from './mcp/envelope.mjs';
import { pushWake } from './mcp/push.mjs';

const delay = (ms, signal) => signal.aborted ? Promise.resolve() : new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });

export class MonitorManager {
  constructor({ server, registry, random = Math.random, onError = value => process.stderr.write(`${JSON.stringify(value)}\n`) }) { this.server = server; this.registry = registry; this.random = random; this.onError = onError; this.active = null; this.listeners = new Set(); }
  trace(stage, details = {}) { if (process.env.AC_MONITOR_DEBUG === '1') process.stderr.write(`${JSON.stringify({event:'room_monitor_trace',stage,...details})}\n`); }
  subscribe(listener) { this.listeners.add(listener); return ()=>this.listeners.delete(listener); }
  emit(row,data) { pushWake(this.server,data); for(const listener of this.listeners)listener(row,data); }
  stop() { this.active?.abort.abort(); this.active = null; for(const listener of this.listeners)listener(null,null); }
  start(client, row) {
    this.stop(); const abort = new AbortController(); this.active = { abort, row }; void this.run(client, row, abort.signal); return abort;
  }
  async run(client, row, signal) {
    let attempt = 0; const seen = new Set();
    while (!signal.aborted) {
      const attemptAbort = new AbortController(); const stopAttempt = () => attemptAbort.abort();
      signal.addEventListener('abort', stopAttempt, { once: true });
      let stage = 'watch';
      try {
        const stream = client.watchNotifications(row.identity_name, { since: 0, signal: attemptAbort.signal });
        let pending = stream.next();
        stage = 'snapshot';
        const [messages, files] = await Promise.all([client.listIncomingMessages(), client.listIncomingFiles()]);
        this.trace('snapshot', {messages:messages.length,files:files.length});
        const unread = new Set([...messages, ...files].filter((item) => item.from?.id === row.contact_cid).map((item) => item.wire_id));
        stage = 'snapshot_wakes';
        for (const wireId of seen) if (!unread.has(wireId)) seen.delete(wireId);
        for (const item of messages) await this.handleOnce(client, row, { event: 'message_received', sender_id: item.from?.id, wire_id: item.wire_id }, seen);
        for (const item of files) await this.handleOnce(client, row, { event: 'file_received', sender_id: item.from?.id, wire_id: item.wire_id }, seen);
        stage = 'notifications';
        while (!signal.aborted) {
          const next = await pending; if (next.done) break; pending = stream.next(); attempt = 0;
          await this.handleOnce(client, row, next.value, seen, true);
        }
      } catch (error) {
        if (signal.aborted) return;
        const name = ['Error', 'TypeError', 'AbortError', 'DaemonUnavailableError'].includes(error?.name) ? error.name : 'Error';
        const code = ['ECONNRESET', 'ECONNREFUSED', 'ENOENT', 'NOT_BOUND', 'BOUND_IDENTITY_GONE'].includes(error?.code) ? error.code : 'monitor_failure';
        this.onError({event:'room_monitor_error',stage,name,code});
      }
      finally { attemptAbort.abort(); signal.removeEventListener('abort', stopAttempt); }
      const ms = Math.min(30_000, 500 * (2 ** Math.min(attempt++, 6))) * (0.8 + this.random() * 0.4);
      await delay(ms, signal);
    }
  }
  async handleOnce(client, row, event, seen, verifyUnread = false) {
    const wireId = event?.wire_id; if (!wireId || seen.has(wireId)) return;
    this.trace('notification', {verifyUnread});
    if (verifyUnread) {
      const kind = event.event ?? event.kind;
      const items = kind === 'message_received' ? await client.listIncomingMessages() : kind === 'file_received' ? await client.listIncomingFiles() : [];
      if (!items.some((item) => item.wire_id === wireId && item.from?.id === row.contact_cid)) { this.trace('skip_read', {kind:['message_received','file_received'].includes(kind)?kind:'other',count:items.length,wireMatch:items.some(item=>item.wire_id===wireId),senderMatch:items.some(item=>item.from?.id===row.contact_cid)}); return; }
    }
    if (await this.handle(client, row, event)) seen.add(wireId);
  }
  wakeRetained(row, item) {
    if(item?.direction!=='in'||item.from?.id!==row.contact_cid||!item.wire_id)return;
    const envelope=parseRoomEnvelope(item.body??item.text??'');
    if(!envelope||!['room_msg','room_briefing'].includes(envelope.kind))return;
    this.emit(row,{room_name:row.room_name,event:'room_message_available',wire_id:item.wire_id,sender_cid:row.contact_cid});
  }
  async handle(client, row, event) {
    const peerCid = event.sender_id ?? event.peer_cid ?? event.from_cid ?? event.from?.id;
    if (peerCid !== row.contact_cid) { this.trace('skip_sender'); return false; }
    const kind = event.event ?? event.kind;
    if (!['message_received', 'file_received'].includes(kind)) return false;
    const contacts = await client.listContacts();
    if (!contacts.contacts?.some((c) => c.container_id === row.contact_cid)) { this.trace('skip_contact'); return false; }
    if (kind === 'file_received') {
      const live = row.membership_state === 'connecting' ? await markReady(this.registry, row) : row;
      Object.assign(row, live);
      this.emit(row, { room_name: live.room_name, event: 'room_file_available', file_id: event.wire_id, author_attribution: 'unavailable' }); return true;
    }
    const wireId = event.wire_id; if (!wireId) return false;
    const item = await client.getHistoryItem({ wire_id: wireId });
    // Contact display labels are not canonical room names. Authenticate the
    // history sender and direction before interpreting any room envelope.
    if(item?.direction!=='in'||item.from?.id!==row.contact_cid){this.trace('skip_history_provenance');return false;}
    if(item.message_kind==='command_result'){
      this.emit(row,{room_name:row.room_name,event:'room_command_result_available',wire_id:wireId,sender_cid:row.contact_cid});return true;
    }
    const envelope = parseRoomEnvelope(item?.body ?? item?.text ?? '');
    if (!envelope || !['room_msg', 'room_briefing'].includes(envelope.kind)) { this.trace('skip_envelope'); return false; }
    this.trace('message_wake');
    const live = row.membership_state === 'connecting' ? await markReady(this.registry, row) : row;
    Object.assign(row, live);
    this.emit(row, { room_name: live.room_name, event: 'room_message_available', wire_id: wireId, sender_cid: row.contact_cid });
    return true;
  }
}
