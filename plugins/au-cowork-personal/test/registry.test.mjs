import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoomRegistry, normalizeRoomName } from '../src/registry.mjs';

const CID = 'A'.repeat(64);
test('room keys are NFC, edge-trimmed, case-sensitive, and display-preserving', async () => {
  assert.equal(normalizeRoomName('  Cafe\u0301  '), 'Café');
  assert.notEqual(normalizeRoomName('Room'), normalizeRoomName('room'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-registry-'));
  const registry = new RoomRegistry('/daemon/a', { appHome: home });
  const row = await registry.create({ roomName: ' Café ', identityName: 'Tutor', contactCid: CID });
  assert.equal(row.room_name, ' Café '); assert.equal(row.normalized_room_name, 'Café');
  await assert.rejects(registry.create({ roomName: 'Café', identityName: 'Other', contactCid: CID }), (e) => e.code === 'room_name_conflict');
  assert.equal((await registry.list()).length, 1);
});

test('registry separates daemon profiles and fails closed on corruption', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-registry-'));
  const one = new RoomRegistry('/daemon/a', { appHome: home }); const two = new RoomRegistry('/daemon/b', { appHome: home });
  await one.create({ roomName: 'Room', identityName: 'Tutor', contactCid: CID });
  assert.deepEqual(await two.list(), []);
  await fs.writeFile(one.fileFor('Room'), '{}');
  await assert.rejects(one.get('Room'), /room_registry_corrupt/);
});
