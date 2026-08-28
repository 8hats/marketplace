import { parseRoomEnvelope } from './mcp/envelope.mjs';
import { pushWake } from './mcp/push.mjs';

const delay = (ms, signal) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });

export class MonitorManager {
  constructor({ server, registry, random = Math.random }) { this.server = server; this.registry = registry; this.random = random; this.active = null; }
  stop() { this.active?.abort.abort(); this.active = null; }
  start(client, row) {
    this.stop(); const abort = new AbortController(); this.active = { abort, row }; void this.run(client, row, abort.signal); return abort;
  }
  async run(client, row, signal) {
    let attempt = 0; const seen = new Set();
    while (!signal.aborted) {
      const attemptAbort = new AbortController(); const stopAttempt = () => attemptAbort.abort();
      signal.addEventListener('abort', stopAttempt, { once: true });
      try {
        const stream = client.watchNotifications(row.identity_name, { since: 0, kinds: ['inbound'], signal: attemptAbort.signal });
        let pending = stream.next();
        const [messages, files] = await Promise.all([client.listIncomingMessages(), client.listIncomingFiles()]);
        const unread = new Set([...messages, ...files].filter((item) => item.from?.id === row.contact_cid).map((item) => item.wire_id));
        for (const wireId of seen) if (!unread.has(wireId)) seen.delete(wireId);
        for (const item of messages) await this.handleOnce(client, row, { event: 'message_received', sender_id: item.from?.id, wire_id: item.wire_id }, seen);
        for (const item of files) await this.handleOnce(client, row, { event: 'file_received', sender_id: item.from?.id, wire_id: item.wire_id }, seen);
        while (!signal.aborted) {
          const next = await pending; if (next.done) break; pending = stream.next(); attempt = 0;
          await this.handleOnce(client, row, next.value, seen, true);
        }
      } catch { if (signal.aborted) return; }
      finally { attemptAbort.abort(); signal.removeEventListener('abort', stopAttempt); }
      const ms = Math.min(30_000, 500 * (2 ** Math.min(attempt++, 6))) * (0.8 + this.random() * 0.4);
      await delay(ms, signal);
    }
  }
  async handleOnce(client, row, event, seen, verifyUnread = false) {
    const wireId = event?.wire_id; if (!wireId || seen.has(wireId)) return;
    if (verifyUnread) {
      const kind = event.event ?? event.kind;
      const items = kind === 'message_received' ? await client.listIncomingMessages() : kind === 'file_received' ? await client.listIncomingFiles() : [];
      if (!items.some((item) => item.wire_id === wireId && item.from?.id === row.contact_cid)) return;
    }
    if (await this.handle(client, row, event)) seen.add(wireId);
  }
  async handle(client, row, event) {
    const peerCid = event.sender_id ?? event.peer_cid ?? event.from_cid ?? event.from?.id;
    if (peerCid !== row.contact_cid) return false;
    const kind = event.event ?? event.kind;
    const contacts = await client.listContacts();
    if (!contacts.contacts?.some((c) => c.container_id === row.contact_cid)) return false;
    if (kind === 'file_received') {
      const live = row.membership_state === 'connecting' ? await this.registry.updateState(row.room_name, 'ready') : row;
      Object.assign(row, live);
      pushWake(this.server, { room_name: live.room_name, event: 'room_file_available', file_id: event.wire_id, author_attribution: 'unavailable' }); return true;
    }
    const wireId = event.wire_id; if (!wireId) return false;
    const item = await client.getHistoryItem({ wire_id: wireId });
    const envelope = parseRoomEnvelope(item?.body ?? item?.text ?? '', row.room_name);
    if (!envelope || envelope.kind !== 'room_msg') return false;
    const live = row.membership_state === 'connecting' ? await this.registry.updateState(row.room_name, 'ready') : row;
    Object.assign(row, live);
    pushWake(this.server, { room_name: live.room_name, event: 'room_message_available', wire_id: wireId, sender_cid: row.contact_cid });
    return true;
  }
}
