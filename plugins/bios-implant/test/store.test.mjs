import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_SOURCE = path.join(PROJECT_ROOT, 'src', 'store.mjs');

async function loadStoreModule() {
  const nonce = `?v=${Date.now()}-${Math.random()}`;
  return import(pathToFileURL(STORE_SOURCE).href + nonce);
}

async function makeSandbox(t, prefix) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });
  return sandbox;
}

function setStateRoot(t, stateRoot) {
  const previous = process.env.BIOS_IMPLANT_STATE_ROOT;
  process.env.BIOS_IMPLANT_STATE_ROOT = stateRoot;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.BIOS_IMPLANT_STATE_ROOT;
    } else {
      process.env.BIOS_IMPLANT_STATE_ROOT = previous;
    }
  });
}

function biosBody(version, suffix = `v${version}`) {
  return `---\nversion: ${version}\n---\n# demo\nBIOS ${suffix}\n`;
}

function digestBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function assertMissing(targetPath) {
  await assert.rejects(fs.access(targetPath), (error) => error?.code === 'ENOENT');
}

test('getConfiguredStateRoot prefers BIOS_IMPLANT_STATE_ROOT over AGENT_UNIVERSITY_HOME', async () => {
  const store = await loadStoreModule();
  const previousOverride = process.env.BIOS_IMPLANT_STATE_ROOT;
  const previousHome = process.env.AGENT_UNIVERSITY_HOME;
  process.env.AGENT_UNIVERSITY_HOME = '/tmp/agent-university-home';
  process.env.BIOS_IMPLANT_STATE_ROOT = '/tmp/bios-implant-override';

  try {
    assert.equal(store.getConfiguredStateRoot(), path.resolve('/tmp/bios-implant-override'));
    delete process.env.BIOS_IMPLANT_STATE_ROOT;
    assert.equal(store.getConfiguredStateRoot(), path.resolve('/tmp/agent-university-home'));
  } finally {
    if (previousOverride === undefined) {
      delete process.env.BIOS_IMPLANT_STATE_ROOT;
    } else {
      process.env.BIOS_IMPLANT_STATE_ROOT = previousOverride;
    }
    if (previousHome === undefined) {
      delete process.env.AGENT_UNIVERSITY_HOME;
    } else {
      process.env.AGENT_UNIVERSITY_HOME = previousHome;
    }
  }
});

test('read-only selection, status, and doctor do not create a missing state root', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-readonly-root-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'missing-state');
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const selection = await store.localSelection({ folder: workspace, roots: [workspace] });
  await assertMissing(stateRoot);
  const status = await store.localStatus({ agentId: 'agent-absent', label: 'default' });
  await assertMissing(stateRoot);
  const doctor = await store.localDoctor({ folder: workspace, roots: [workspace] });
  await assertMissing(stateRoot);

  assert.equal(selection.bound, false);
  assert.equal(status.staged, false);
  assert.equal(doctor.state_root.exists, false);
  assert.equal(doctor.healthy, true);
  assert.deepEqual(doctor.errors, []);
  assert.deepEqual(doctor.warnings, ['BINDING_REQUIRED']);
});

test('local_connect collapses symlink aliases to one binding key', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-link-');
  const workspace = path.join(sandbox, 'workspace');
  const alias = path.join(sandbox, 'workspace-link');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  try {
    await fs.symlink(workspace, alias, 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('directory symlink creation is unavailable in this environment');
      return;
    }
    throw error;
  }
  setStateRoot(t, stateRoot);

  const result = await store.localConnect({
    agentId: 'agent-one',
    folder: alias,
    roots: [sandbox],
  });
  const directSelection = await store.localSelection({
    folder: workspace,
    roots: [sandbox],
  });
  const aliasSelection = await store.localSelection({
    folder: alias,
    roots: [sandbox],
  });

  assert.equal(result.workspace_root, await fs.realpath(workspace));
  assert.equal(directSelection.bound, true);
  assert.equal(aliasSelection.bound, true);
  assert.equal(directSelection.binding_hash, aliasSelection.binding_hash);
  assert.equal(directSelection.binding_path, aliasSelection.binding_path);
  assert.equal(
    result.binding_path,
    path.join(await fs.realpath(stateRoot), 'bios', 'projects', directSelection.binding_hash, 'binding.json'),
  );
});

test('parent and child folders remain distinct bindings', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-parent-');
  const parent = path.join(sandbox, 'parent');
  const child = path.join(parent, 'child');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(child, { recursive: true });
  setStateRoot(t, stateRoot);

  await store.localConnect({ agentId: 'agent-parent', folder: parent, roots: [sandbox] });
  await store.localConnect({ agentId: 'agent-child', folder: child, roots: [sandbox] });

  const parentSelection = await store.localSelection({ folder: parent, roots: [sandbox] });
  const childSelection = await store.localSelection({ folder: child, roots: [sandbox] });

  assert.equal(parentSelection.agent_id, 'agent-parent');
  assert.equal(childSelection.agent_id, 'agent-child');
  assert.notEqual(parentSelection.binding_hash, childSelection.binding_hash);
});

test('malformed or invalid binding records fail closed and doctor reports local damage', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-broken-binding-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const connected = await store.localConnect({
    agentId: 'agent-binding',
    folder: workspace,
    roots: [workspace],
  });
  const malformedSecret = 'do-not-echo-binding-payload';
  await fs.writeFile(connected.binding_path, `{not-json:${malformedSecret}`, 'utf8');

  await assert.rejects(
    store.localSelection({ folder: workspace, roots: [workspace] }),
    (error) => error?.code === 'BINDING_UNREADABLE',
  );
  const malformedDoctor = await store.localDoctor({ folder: workspace, roots: [workspace] });
  assert.equal(malformedDoctor.healthy, false);
  assert.deepEqual(malformedDoctor.errors, ['BINDING_UNREADABLE']);
  assert.deepEqual(malformedDoctor.warnings, []);
  assert.equal(JSON.stringify(malformedDoctor).includes(malformedSecret), false);

  await fs.writeFile(connected.binding_path, 'null', 'utf8');
  await assert.rejects(
    store.localSelection({ folder: workspace, roots: [workspace] }),
    (error) => error?.code === 'BINDING_UNREADABLE',
  );

  await fs.writeFile(
    connected.binding_path,
    JSON.stringify({ agent_id: '../../outside', label: 'default', workspace_root: workspace }),
    'utf8',
  );
  await assert.rejects(
    store.localSelection({ folder: workspace, roots: [workspace] }),
    (error) => error?.code === 'BINDING_UNREADABLE',
  );
});

test('local_connect writes per-agent identities without overwrite', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-identities-');
  const workspaceOne = path.join(sandbox, 'workspace-one');
  const workspaceTwo = path.join(sandbox, 'workspace-two');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspaceOne, { recursive: true });
  await fs.mkdir(workspaceTwo, { recursive: true });
  setStateRoot(t, stateRoot);

  const first = await store.localConnect({
    agentId: 'agent-one',
    label: 'default',
    folder: workspaceOne,
    roots: [sandbox],
  });
  const second = await store.localConnect({
    agentId: 'agent-two',
    label: 'review',
    folder: workspaceTwo,
    roots: [sandbox],
  });

  const firstIdentity = JSON.parse(await fs.readFile(first.identity_path, 'utf8'));
  const secondIdentity = JSON.parse(await fs.readFile(second.identity_path, 'utf8'));

  const canonicalStateRoot = await fs.realpath(stateRoot);
  assert.equal(first.identity_path, path.join(canonicalStateRoot, 'agents', 'agent-one', 'identity.json'));
  assert.equal(second.identity_path, path.join(canonicalStateRoot, 'agents', 'agent-two', 'identity.json'));
  assert.equal(firstIdentity.agent_id, 'agent-one');
  assert.equal(secondIdentity.agent_id, 'agent-two');
  assert.equal(Object.hasOwn(firstIdentity, 'workspace_root'), false);
  assert.equal(Object.hasOwn(firstIdentity, 'label'), false);

  if (process.platform !== 'win32') {
    const firstMode = (await fs.stat(first.identity_path)).mode & 0o777;
    const secondMode = (await fs.stat(second.identity_path)).mode & 0o777;
    assert.equal(firstMode & 0o077, 0);
    assert.equal(secondMode & 0o077, 0);
  }
});

test('stageBios writes canonical default and labeled layouts with regular active files', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-layout-');
  setStateRoot(t, sandbox);

  const defaultStage = await store.stageBios({
    agentId: 'agent-layout',
    label: 'default',
    body: biosBody(5, 'default'),
    version: 5,
    etag: '"etag-default"',
  });
  const reviewStage = await store.stageBios({
    agentId: 'agent-layout',
    label: 'review',
    body: biosBody(1, 'review'),
    version: 1,
    etag: '"etag-review"',
  });
  const canonicalSandbox = await fs.realpath(sandbox);

  assert.equal(defaultStage.status_path, path.join(canonicalSandbox, 'agents', 'agent-layout', 'status.json'));
  assert.equal(defaultStage.active_path, path.join(canonicalSandbox, 'agents', 'agent-layout', 'active-bios.md'));
  assert.equal(
    defaultStage.generation_path,
    path.join(canonicalSandbox, 'agents', 'agent-layout', 'generations', '5-etag-default', 'bios.md'),
  );
  assert.equal(reviewStage.status_path, path.join(canonicalSandbox, 'agents', 'agent-layout', 'labels', 'review', 'status.json'));
  assert.equal(reviewStage.active_path, path.join(canonicalSandbox, 'agents', 'agent-layout', 'labels', 'review', 'active-bios.md'));
  assert.equal(
    reviewStage.generation_path,
    path.join(canonicalSandbox, 'agents', 'agent-layout', 'labels', 'review', 'generations', '1-etag-review', 'bios.md'),
  );

  const defaultActive = await fs.lstat(defaultStage.active_path);
  const reviewActive = await fs.lstat(reviewStage.active_path);
  assert.equal(defaultActive.isSymbolicLink(), false);
  assert.equal(reviewActive.isSymbolicLink(), false);
  assert.equal(defaultActive.isFile(), true);
  assert.equal(reviewActive.isFile(), true);
});

test('localStatus returns a validated fallback BIOS body', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-fallback-');
  const body = biosBody(9, 'fallback');
  setStateRoot(t, sandbox);

  await store.stageBios({
    agentId: 'agent-fallback',
    label: 'default',
    body,
    version: 9,
    etag: '"etag-fallback"',
  });

  const status = await store.localStatus({ agentId: 'agent-fallback', label: 'default' });

  assert.equal(status.bios_body, body);
});

test('stageBios isolates agents and rejects downgrade and same-version drift', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-stage-');
  setStateRoot(t, sandbox);

  await store.stageBios({
    agentId: 'agent-a',
    label: 'default',
    body: biosBody(5, 'agent-a'),
    version: 5,
    etag: '"etag-a"',
  });
  await store.stageBios({
    agentId: 'agent-b',
    label: 'default',
    body: biosBody(2, 'agent-b'),
    version: 2,
    etag: '"etag-b"',
  });

  const statusA = await store.localStatus({ agentId: 'agent-a', label: 'default' });
  const statusB = await store.localStatus({ agentId: 'agent-b', label: 'default' });

  assert.equal(statusA.bios_version, 5);
  assert.equal(statusB.bios_version, 2);
  assert.notEqual(statusA.generation_path, statusB.generation_path);

  await assert.rejects(
    store.stageBios({
      agentId: 'agent-a',
      label: 'default',
      body: biosBody(4, 'downgrade'),
      version: 4,
      etag: '"etag-a-4"',
    }),
    (error) => error?.code === 'DOWNGRADE_REFUSED',
  );

  await assert.rejects(
    store.stageBios({
      agentId: 'agent-a',
      label: 'default',
      body: biosBody(5, 'drift'),
      version: 5,
      etag: '"etag-a-drift"',
    }),
    (error) => error?.code === 'VERSION_CONFLICT',
  );
});

test('localStatus reads the compatibility bios/agents staging layout', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-compat-');
  setStateRoot(t, sandbox);

  const compatHome = path.join(sandbox, 'bios', 'agents', 'agent-compat', 'default');
  const generationPath = path.join(compatHome, 'generations', '3-etag-compat', 'bios.md');
  const activePath = path.join(compatHome, 'active-bios.md');
  const statusPath = path.join(compatHome, 'status.json');
  await fs.mkdir(path.dirname(generationPath), { recursive: true });
  await fs.writeFile(generationPath, biosBody(3, 'compat'), 'utf8');
  await fs.writeFile(activePath, biosBody(3, 'compat'), 'utf8');
  await fs.writeFile(
    statusPath,
    JSON.stringify({
      schema_version: 1,
      agent_id: 'agent-compat',
      label: 'default',
      bios_version: 3,
      etag: '"etag-compat"',
      digest: digestBytes(Buffer.from(biosBody(3, 'compat'), 'utf8')),
      staged_at: '2026-08-03T00:00:00.000Z',
      active: generationPath,
    }),
    'utf8',
  );

  const status = await store.localStatus({ agentId: 'agent-compat', label: 'default' });

  assert.equal(status.staged, true);
  assert.equal(status.layout, 'compat_bios_agents');
  assert.equal(status.active_path, await fs.realpath(activePath));
  assert.equal(status.generation_path, generationPath);
});

test('localStatus fails closed on tampered, missing, or oversized staged BIOS bodies', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-invalid-body-');
  setStateRoot(t, sandbox);

  const staged = await store.stageBios({
    agentId: 'agent-invalid',
    label: 'default',
    body: biosBody(4, 'valid'),
    version: 4,
    etag: '"etag-valid"',
  });

  await fs.writeFile(staged.generation_path, biosBody(4, 'tampered'), 'utf8');
  await assert.rejects(
    store.localStatus({ agentId: 'agent-invalid', label: 'default' }),
    (error) => error?.code === 'STAGED_BIOS_UNREADABLE' && error?.details?.reason === 'digest mismatch',
  );

  await fs.rm(staged.generation_path);
  await assert.rejects(
    store.localStatus({ agentId: 'agent-invalid', label: 'default' }),
    (error) => error?.code === 'STAGED_BIOS_UNREADABLE' && error?.details?.reason === 'missing or unreadable body',
  );

  const oversizedHome = path.join(sandbox, 'agents', 'agent-oversize');
  const oversizedGenerationPath = path.join(oversizedHome, 'generations', '1-etag-oversize', 'bios.md');
  const oversizedBytes = Buffer.alloc((10 * 1024 * 1024) + 1, 'a');
  await fs.mkdir(path.dirname(oversizedGenerationPath), { recursive: true });
  await fs.writeFile(oversizedGenerationPath, oversizedBytes);
  await fs.writeFile(
    path.join(oversizedHome, 'status.json'),
    JSON.stringify({
      schema_version: 1,
      agent_id: 'agent-oversize',
      label: 'default',
      bios_version: 1,
      etag: '"etag-oversize"',
      digest: digestBytes(oversizedBytes),
      staged_at: '2026-08-03T00:00:00.000Z',
      active: oversizedGenerationPath,
    }),
    'utf8',
  );
  await fs.writeFile(path.join(oversizedHome, 'active-bios.md'), 'placeholder', 'utf8');

  await assert.rejects(
    store.localStatus({ agentId: 'agent-oversize', label: 'default' }),
    (error) => error?.code === 'STAGED_BIOS_UNREADABLE' && error?.details?.reason === 'body exceeds size limit',
  );
});

test('localStatus rejects status.active paths outside the expected generation layout', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-active-path-');
  const body = biosBody(8, 'outside');
  setStateRoot(t, sandbox);

  const staged = await store.stageBios({
    agentId: 'agent-active-path',
    label: 'default',
    body,
    version: 8,
    etag: 'etag-outside',
  });
  const outsidePath = path.join(sandbox, 'outside-bios.md');
  await fs.writeFile(outsidePath, body, 'utf8');
  const statusRecord = JSON.parse(await fs.readFile(staged.status_path, 'utf8'));
  statusRecord.active = outsidePath;
  await fs.writeFile(staged.status_path, JSON.stringify(statusRecord), 'utf8');

  await assert.rejects(
    store.localStatus({ agentId: 'agent-active-path', label: 'default' }),
    (error) => error?.code === 'STATUS_UNREADABLE',
  );
  await assert.rejects(
    store.stageBios({
      agentId: 'agent-active-path',
      label: 'default',
      body,
      version: 8,
      etag: 'etag-outside-repeat',
    }),
    (error) => error?.code === 'STATUS_UNREADABLE',
  );
});

test('connect and stage append canonical ownership ledger entries with digests', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-ledger-');
  const workspace = path.join(sandbox, 'workspace');
  const stateRoot = path.join(sandbox, 'state');
  await fs.mkdir(workspace, { recursive: true });
  setStateRoot(t, stateRoot);

  const connect = await store.localConnect({
    agentId: 'agent-ledger',
    label: 'default',
    folder: workspace,
    roots: [sandbox],
  });
  const staged = await store.stageBios({
    agentId: 'agent-ledger',
    label: 'default',
    body: biosBody(3, 'ledger'),
    version: 3,
    etag: '"etag-ledger"',
  });
  const canonicalStateRoot = await fs.realpath(stateRoot);
  const entries = await store.readOwnershipLedger({ stateRoot: canonicalStateRoot });

  assert.equal(store.OWNERSHIP_OWNER_ID, '@agentuniversity/bios-implant');
  assert.equal(store.OWNERSHIP_LEDGER_RELATIVE_PATH, 'bios-implant/owned-state.jsonl');
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['identity', 'binding', 'generation', 'status', 'active'],
  );

  const expectedByKind = new Map([
    ['identity', path.join('agents', 'agent-ledger', 'identity.json')],
    ['binding', path.relative(canonicalStateRoot, connect.binding_path)],
    ['generation', path.relative(canonicalStateRoot, staged.generation_path)],
    ['status', path.relative(canonicalStateRoot, staged.status_path)],
    ['active', path.relative(canonicalStateRoot, staged.active_path)],
  ]);

  for (const entry of entries) {
    assert.equal(entry.schema_version, 1);
    assert.equal(entry.owner, store.OWNERSHIP_OWNER_ID);
    assert.equal(entry.relative_path.includes('..'), false);
    assert.equal(path.isAbsolute(entry.relative_path), false);
    assert.equal(entry.relative_path, expectedByKind.get(entry.kind).split(path.sep).join('/'));

    const bytes = await fs.readFile(path.join(canonicalStateRoot, ...entry.relative_path.split('/')));
    assert.equal(entry.digest_sha256, digestBytes(bytes));
  }

  const ledgerMode = (await fs.stat(path.join(canonicalStateRoot, 'bios-implant', 'owned-state.jsonl'))).mode & 0o777;
  if (process.platform !== 'win32') {
    assert.equal(ledgerMode & 0o077, 0);
  }
});

test('idempotent stage does not append redundant ownership records', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-ledger-idempotent-');
  setStateRoot(t, sandbox);

  await store.stageBios({
    agentId: 'agent-stable',
    label: 'default',
    body: biosBody(7, 'stable'),
    version: 7,
    etag: '"etag-stable"',
  });
  const before = await store.readOwnershipLedger({ stateRoot: sandbox });
  const repeat = await store.stageBios({
    agentId: 'agent-stable',
    label: 'default',
    body: biosBody(7, 'stable'),
    version: 7,
    etag: '"etag-stable-new"',
  });
  const after = await store.readOwnershipLedger({ stateRoot: sandbox });

  assert.equal(repeat.changed, false);
  assert.equal(after.length, before.length);
});

test('equal-version staging repairs stale digest metadata and records repaired ownership', { concurrency: false }, async (t) => {
  const store = await loadStoreModule();
  const sandbox = await makeSandbox(t, 'implant-local-ledger-repair-');
  const body = biosBody(11, 'digest-repair');
  setStateRoot(t, sandbox);

  const staged = await store.stageBios({
    agentId: 'agent-repair',
    label: 'default',
    body,
    version: 11,
    etag: 'etag-repair',
  });
  const damagedStatus = JSON.parse(await fs.readFile(staged.status_path, 'utf8'));
  damagedStatus.digest = 'stale-digest-metadata';
  await fs.writeFile(staged.status_path, JSON.stringify(damagedStatus), 'utf8');
  const before = await store.readOwnershipLedger({ stateRoot: sandbox });

  const repaired = await store.stageBios({
    agentId: 'agent-repair',
    label: 'default',
    body,
    version: 11,
    etag: 'etag-repair-new',
  });
  const repairedStatusBytes = await fs.readFile(staged.status_path);
  const repairedStatus = JSON.parse(repairedStatusBytes.toString('utf8'));
  const after = await store.readOwnershipLedger({ stateRoot: sandbox });

  assert.equal(repaired.changed, true);
  assert.equal(repaired.digest, digestBytes(Buffer.from(body, 'utf8')));
  assert.equal(repairedStatus.digest, repaired.digest);
  assert.equal(after.length, before.length + 1);
  assert.equal(after.at(-1).kind, 'status');
  assert.equal(after.at(-1).digest_sha256, digestBytes(repairedStatusBytes));

  const stable = await store.stageBios({
    agentId: 'agent-repair',
    label: 'default',
    body,
    version: 11,
    etag: 'etag-repair-third',
  });
  const finalLedger = await store.readOwnershipLedger({ stateRoot: sandbox });
  assert.equal(stable.changed, false);
  assert.equal(finalLedger.length, after.length);
});
