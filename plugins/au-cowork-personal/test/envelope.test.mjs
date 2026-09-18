import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRoomEnvelope } from '../src/mcp/envelope.mjs';

test('only exact v1 room envelopes pass', () => {
  const base = { version: 1, kind: 'room_msg', room_id: 'r1', room_name: 'Room', at: '2026-08-28T00:00:00.000Z', author: { display_name: 'Alice', identity: 'A'.repeat(64), role: 'Owner' }, message_id: 'm1', text: 'hello' };
  const valid = JSON.stringify(base);
  assert.equal(parseRoomEnvelope(valid, 'Room').message_id, 'm1');
  for (const bad of ['x', '[]', '{}', JSON.stringify({ ...base, version: 2 }), JSON.stringify({ ...base, room_name: 'Other' }),
    JSON.stringify({ ...base, message_id: undefined }), JSON.stringify({ ...base, text: undefined }), JSON.stringify({ ...base, author: undefined }),
    JSON.stringify({ ...base, author: { ...base.author, identity: 'bad' } }), JSON.stringify({ ...base, extra: true })]) assert.equal(parseRoomEnvelope(bad, 'Room'), null);
  const file = { version: 1, kind: 'room_file', room_id: '01hzyk8m0000000000000000aa', room_name: 'Room', file_id: '01hzyk8m0000000000000000af', author: base.author, filename: 'report.pdf', mime: 'application/pdf', size: 1536, sha256: 'a'.repeat(64), at: base.at };
  assert.equal(parseRoomEnvelope(JSON.stringify(file), 'Room').sha256, 'a'.repeat(64));
  assert.equal(parseRoomEnvelope(JSON.stringify({ ...file, sha256: undefined }), 'Room'), null);
  assert.equal(parseRoomEnvelope(JSON.stringify({ ...base, reply_to: null }), 'Room'), null);
});
