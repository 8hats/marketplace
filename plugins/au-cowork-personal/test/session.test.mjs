import assert from 'node:assert/strict';
import test from 'node:test';
import { CoworkSession } from '../src/session.mjs';

test('release is idempotent and next operation attaches a fresh client', async () => {
  let attached = 0; let released = 0;
  const session = new CoworkSession({ resolve: () => ({ expectStateDir: '/x' }), attach: async () => ({ id: ++attached, async releaseLease() { released++; } }) });
  assert.equal((await session.ensureAttached()).id, 1); await session.release(); await session.release();
  assert.equal((await session.ensureAttached()).id, 2); assert.equal(released, 1);
});
