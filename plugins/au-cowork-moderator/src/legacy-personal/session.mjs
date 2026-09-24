import { randomBytes } from 'node:crypto';
import { attachOursClient, resolveDaemonConfig } from '@ours.network/sdk/client';
import { resolveRemoteConfig, attachRemote, remoteError } from './remote-config.mjs';

export class CoworkSession {
  constructor({ attach = attachOursClient, resolve = resolveDaemonConfig, remote, resolveRemote = resolveRemoteConfig, attachRemoteFn = attachRemote } = {}) {
    this.resolveRemote = remote === undefined ? resolveRemote : () => remote;
    this.resolveLocal = resolve; this.attachFn = attach; this.attachRemoteFn = attachRemoteFn;
    this.selected = null; this.remote = null;
    this.ownerToken = randomBytes(32).toString('hex'); this.client = null; this.bound = null;
  }
  get selection() {
    if (!this.selected) {
      const remote = this.resolveRemote();
      let selected;
      try { selected = remote ? { expectStateDir: `remote:${remote.url}`, registryKey: `remote:${remote.url}` } : this.resolveLocal(); }
      catch { throw remoteError('daemon_setup_required'); }
      this.remote = remote; this.selected = selected;
    }
    return this.selected;
  }
  async ensureAttached() {
    const selection = this.selection;
    if (!this.client) {
      try {
        this.client = this.remote
          ? await this.attachRemoteFn(this.remote,{leaseToken:this.ownerToken})
          : await this.attachFn({ ...(selection.baseUrl ? {endpoint:selection.baseUrl.value,expectStateDir:selection.expectStateDir,token:selection.token?.value,env:{}} : {}), leaseToken: this.ownerToken, clientPid: process.pid });
      } catch (error) {
        const failure = this.remote ? error : remoteError('daemon_setup_required');
        // No client was acquired and no invitation submitted. Allow corrected
        // settings on the next operation; successful attachments stay pinned.
        this.selected = null; this.remote = null;
        throw failure;
      }
    }
    return this.client;
  }
  async release() {
    if (this.remote && this.client) {
      // Terminal release closes all temporary identities owned by this lease.
      // Keep the owner available if release fails so the caller can inspect/retry.
      await this.client.releaseLease();
      await this.client.close();
      this.client = null; this.bound = null; this.temporaryName = null;
      this.ownerToken = randomBytes(32).toString('hex');
      this.selected = null; this.remote = null;
      return;
    }
    const client = this.client, temporaryName = this.temporaryName; this.client = null; this.bound = null; this.temporaryName = null;
    if (client && temporaryName) await client.closeTemporaryIdentityOp({ name: temporaryName }).catch(() => undefined);
    if (client) await client.releaseLease().catch(() => undefined);
    if (client?.close) await client.close().catch(() => undefined);
    this.ownerToken = randomBytes(32).toString('hex');
    this.selected = null; this.remote = null;
  }
}
