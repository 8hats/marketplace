import { randomBytes } from 'node:crypto';
import { attachOursClient, resolveDaemonConfig } from '@ours.network/sdk/client';

export class CoworkSession {
  constructor({ attach = attachOursClient, resolve = resolveDaemonConfig } = {}) {
    this.attachFn = attach; this.selection = resolve(); this.client = null; this.bound = null;
  }
  async ensureAttached() {
    if (!this.client) this.client = await this.attachFn({ leaseToken: randomBytes(32).toString('hex'), clientPid: process.pid });
    return this.client;
  }
  async release() {
    const client = this.client; this.client = null; this.bound = null;
    if (client) await client.releaseLease().catch(() => undefined);
  }
}
