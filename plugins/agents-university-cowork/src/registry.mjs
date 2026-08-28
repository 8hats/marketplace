import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SCHEMA_VERSION = 1;
export const MAX_ROOM_NAME = 256;

export function normalizeRoomName(value) {
  if (typeof value !== 'string') throw new Error('room name must be a string');
  const normalized = value.normalize('NFC').trim();
  if (!normalized || [...normalized].length > MAX_ROOM_NAME) throw new Error('room name is empty or too long');
  return normalized;
}
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export class RoomRegistry {
  constructor(stateDir, { appHome = path.join(os.homedir(), '.agents-university-cowork') } = {}) {
    this.appHome = appHome; this.profileRoot = path.join(appHome, hash(path.resolve(stateDir)));
    this.root = path.join(this.profileRoot, 'rooms');
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const dir of [this.appHome, this.profileRoot, this.root]) await fs.chmod(dir, 0o700);
  }
  fileFor(roomName) { return path.join(this.root, `${hash(normalizeRoomName(roomName))}.json`); }
  validate(row) {
    if (!row || row.schema_version !== SCHEMA_VERSION || typeof row.room_name !== 'string' ||
      typeof row.identity_name !== 'string' || !/^[0-9A-F]{64}$/.test(row.contact_cid) ||
      !['connecting', 'ready'].includes(row.membership_state)) throw new Error('room_registry_corrupt');
    if (normalizeRoomName(row.room_name) !== row.normalized_room_name) throw new Error('room_registry_corrupt');
    return row;
  }
  async create({ roomName, identityName, contactCid, membershipState = 'connecting' }) {
    await this.init();
    const normalized = normalizeRoomName(roomName);
    const now = new Date().toISOString();
    const row = { schema_version: SCHEMA_VERSION, room_name: roomName, normalized_room_name: normalized,
      identity_name: identityName, contact_cid: contactCid, membership_state: membershipState,
      created_at: now, updated_at: now };
    const handle = await fs.open(this.fileFor(normalized), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      .catch((error) => { if (error.code === 'EEXIST') { const e = new Error('room_name_conflict'); e.code = 'room_name_conflict'; throw e; } throw error; });
    try { await handle.writeFile(`${JSON.stringify(row, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    const dir = await fs.open(this.root, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    return row;
  }
  async get(roomName) {
    const raw = await fs.readFile(this.fileFor(roomName), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    return raw === null ? null : this.validate(JSON.parse(raw));
  }
  async list() {
    await this.init(); const out = [];
    for (const name of await fs.readdir(this.root)) if (name.endsWith('.json')) out.push(this.validate(JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8'))));
    return out.sort((a, b) => a.room_name.localeCompare(b.room_name));
  }
  async updateState(roomName, membershipState) {
    const row = await this.get(roomName); if (!row) throw Object.assign(new Error('room_not_found'), { code: 'room_not_found' });
    const next = { ...row, membership_state: membershipState, updated_at: new Date().toISOString() };
    const target = this.fileFor(roomName); const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, target);
    const dir = await fs.open(this.root, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    return next;
  }
}
