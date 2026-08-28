import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('the public surface is exactly the ten frozen tools', async () => {
  const source = await fs.readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const names = [...source.matchAll(/register\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, [
    'enter_room', 'connect_to_room', 'disconnect_from_room', 'list_rooms', 'get_room_status',
    'send_room_message', 'read_room_messages', 'reply_to_room_message', 'send_room_file', 'read_room_files'
  ]);
});
