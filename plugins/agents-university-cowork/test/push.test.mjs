import assert from 'node:assert/strict';
import test from 'node:test';
import { pushWake } from '../src/mcp/push.mjs';

test('push absorbs synchronous and asynchronous transport failures', async () => {
  let errors = 0;
  pushWake({ sendLoggingMessage() { throw new Error('closed'); } }, {}, () => errors++);
  pushWake({ sendLoggingMessage() { return Promise.reject(new Error('closed')); } }, {}, () => errors++);
  await new Promise((r) => setImmediate(r)); assert.equal(errors, 2);
});

test('wake data is body-free', () => {
  let sent; pushWake({ sendLoggingMessage(value) { sent = value; } }, { room_name: 'Room', event: 'room_message_available', wire_id: 'A'.repeat(64) });
  assert.equal(sent.level, 'info'); assert.doesNotMatch(sent.data, /body|hello|bytes/);
});
