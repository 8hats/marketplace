/**
 * The servable agent-id rule exists three times: here (store.mjs AGENT_ID_PATTERN, from which
 * the tool schemas derive), in app-v2 (lib/setup/render.ts AGENT_ID_SERVABLE — the creation,
 * issuance and preview gate), and in bios-server (src/safety/slug.ts — the serve-side check
 * that 422s /load BEFORE auth). A divergence is not a style question: an id one side accepts
 * and another rejects fails AFTER the one-use capability has been spent, which no retry
 * repairs. TVP_TEST_2-paired-2026-08 (2026-08-10) was exactly that — minted wide, served
 * narrow, dead at first bios_load.
 *
 * Cross-repo, so each sibling check SKIPS loudly when the checkout is absent — CI does not
 * check out the siblings. A skip is not a pass: it prints where it looked, so a silent skip
 * cannot be mistaken for agreement. Same shape as app-v2's agent-id.parity.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_ID_PATTERN, AGENT_ID_RE, LABEL_RE } from '../src/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dicodex workspace layout: <workspace>/plugins/plugins/bios-implant/test → siblings at <workspace>/. */
const WORKSPACE = path.resolve(HERE, '..', '..', '..', '..');
const APP_V2_RENDER = path.join(WORKSPACE, 'agent-university-app-v2', 'lib', 'setup', 'render.ts');
const BIOS_SLUG = path.join(WORKSPACE, 'bios-server', 'src', 'safety', 'slug.ts');

test('AGENT_ID_PATTERN is byte-identical to app-v2 AGENT_ID_SERVABLE', (t) => {
  if (!existsSync(APP_V2_RENDER)) {
    t.skip(`SKIPPED — no sibling checkout at ${APP_V2_RENDER}. This does NOT mean the copies agree; it means nothing checked.`);
    return;
  }
  const source = readFileSync(APP_V2_RENDER, 'utf8');
  const match = /AGENT_ID_SERVABLE = \/(.+)\/;/.exec(source);
  assert.ok(match, `app-v2 render.ts no longer declares AGENT_ID_SERVABLE — re-align this parity test with the gate that replaced it`);
  assert.equal(
    `^${AGENT_ID_PATTERN}$`,
    match[1],
    'plugin AGENT_ID_PATTERN and app-v2 AGENT_ID_SERVABLE have drifted; apply the change to both',
  );
});

test('AGENT_ID_PATTERN matches exactly what bios-server slugs will serve', (t) => {
  if (!existsSync(BIOS_SLUG)) {
    t.skip(`SKIPPED — no sibling checkout at ${BIOS_SLUG}. This does NOT mean the copies agree; it means nothing checked.`);
    return;
  }
  // slug.ts is per-char + length, not a regex — compare by behaviour over a discriminating
  // corpus instead of by bytes. Every case that ever shipped a defect is here.
  const source = readFileSync(BIOS_SLUG, 'utf8');
  const first = /const FIRST = \/(.+)\/;/.exec(source);
  const rest = /const REST = \/(.+)\/;/.exec(source);
  const max = /s\.length > (\d+)/.exec(source);
  assert.ok(first && rest && max, 'bios-server slug.ts changed shape — re-derive this parity check');
  const firstRe = new RegExp(first[1]);
  const restRe = new RegExp(rest[1]);
  const maxLen = Number(max[1]);
  const slugAccepts = (value) => value.length >= 1 && value.length <= maxLen
    && firstRe.test(value[0])
    && [...value.slice(1)].every((ch) => restRe.test(ch));
  const corpus = [
    'MEOW-15-paired-2026-08', 'agent-real-network', 'a', 'X9',
    'TVP_TEST_2-paired-2026-08', 'BOT-V1.2-paired-2026-08', '-lead', 'A'.repeat(64), 'A'.repeat(65),
    'ПРИВЕТ-paired-2026-08', 'a b', '',
  ];
  for (const value of corpus) {
    assert.equal(
      AGENT_ID_RE.test(value),
      slugAccepts(value),
      `plugin and bios-server disagree on ${JSON.stringify(value)}`,
    );
  }
});

test('labels are held to the same servable rule as agent ids', () => {
  // bios-server validates label with the SAME slug as agent_id; a label the plugin binds but
  // the server refuses fails at bios_load time with the binding already written.
  assert.equal(LABEL_RE.source, AGENT_ID_RE.source);
});
