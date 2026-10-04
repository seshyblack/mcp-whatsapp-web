import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CampaignStore, selectCandidates, redactDraft } from '../src/services/campaigns.ts';
import { readOnlyBackend } from '../src/services/read-only-backend.ts';
import { checkOwnerHeader } from '../src/auth/owner.ts';

const rules = { sourceGroup: 'source@g.us', excludeGroups: ['excluded@g.us'], campaign: 'test', markers: ['invitation'], excludeAnyPreviousOutbound: true };
const recipient = { id: '123@c.us', displayName: 'Alex Example', steps: [{ kind: 'text', text: 'Hi Alex, test draft.' }] };
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wa-campaign-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'campaigns.json');
  return { file, store: new CampaignStore(file) };
}
function member(id, overrides = {}) {
  return { id, aliases: [id], identityResolved: true, contact: { id, name: null, pushname: 'Alex Example', isMe: false, isUser: true, savedStatus: 'unsaved', ...overrides } };
}
function backend(source = [member('123@c.us')], excluded = [], messages = []) {
  return {
    getStatus: () => ({ authenticated: true, history: { state: 'available' } }),
    getGroupMembers: async id => id === rules.sourceGroup ? source : excluded,
    getMessages: async () => messages,
    sendMessage: async () => ({ id: 'sent-1' }),
    sendMediaFromBase64: async () => ({ id: 'sent-image' }),
  };
}
const approve = (store, d) => store.approve(d.id, d.csrf, d.digest);

test('unapproved drafts cannot send; approval secrets are absent from MCP preview', async t => {
  const { store, file } = fixture(t);
  const d = store.create(rules, [recipient]);
  let sends = 0;
  const b = backend(); b.sendMessage = async () => { sends++; };
  await assert.rejects(store.execute(d.id, b, async () => {}), /approved/);
  assert.equal(sends, 0);
  assert.equal('csrf' in redactDraft(d), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
test('approval requires exact digest and CSRF; input mutation does not change draft', t => {
  const { store } = fixture(t);
  const mutable = structuredClone(recipient);
  const d = store.create(rules, [mutable]);
  mutable.steps[0].text = 'different';
  assert.equal(store.get(d.id).recipients[0].steps[0].text, recipient.steps[0].text);
  assert.throws(() => store.approve(d.id, 'bad', d.digest));
  assert.throws(() => store.approve(d.id, d.csrf, 'bad'));
  approve(store, d);
  assert.throws(() => approve(store, d));
});
test('approved exact sequence sends once, including across store instances', async t => {
  const { store, file } = fixture(t);
  const d = store.create(rules, [recipient]); approve(store, d);
  const second = new CampaignStore(file);
  let sent = [];
  const b = backend(); b.sendMessage = async (...args) => { sent.push(args); return { id: 'sent-1' }; };
  assert.equal((await store.execute(d.id, b, async () => {})).status, 'sent');
  assert.deepEqual(sent, [[recipient.id, recipient.steps[0].text]]);
  await assert.rejects(second.execute(d.id, b, async () => {}));
  assert.equal(sent.length, 1);
  assert.equal(second.contacted('123@s.whatsapp.net'), true);
});
test('uncertain network outcome is durable and cannot be automatically retried', async t => {
  const { store, file } = fixture(t);
  const d = store.create(rules, [recipient]); approve(store, d);
  const b = backend(); b.sendMessage = async () => { throw new Error('connection lost after remote may have received'); };
  await assert.rejects(store.execute(d.id, b, async () => {}));
  const restored = new CampaignStore(file);
  assert.equal(restored.get(d.id).status, 'uncertain');
  assert.equal(restored.contacted(recipient.id), true);
  await assert.rejects(restored.execute(d.id, backend(), async () => {}));
});
test('concurrent executions cannot send twice', async t => {
  const { store } = fixture(t);
  const d = store.create(rules, [recipient]); approve(store, d);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const first = store.execute(d.id, backend(), () => wait);
  await assert.rejects(store.execute(d.id, backend(), async () => {}), /EEXIST/);
  release(); await first;
});
test('eligibility recheck failure prevents outbound send', async t => {
  const { store } = fixture(t); const d = store.create(rules, [recipient]); approve(store, d);
  let sends = 0; const b = backend(); b.sendMessage = async () => { sends++; };
  await assert.rejects(store.execute(d.id, b, async () => { throw new Error('now saved'); }));
  assert.equal(sends, 0);
});
test('saved, unknown, missing-name and cross-group contacts are excluded', async t => {
  const { store } = fixture(t);
  const b = backend([member('1@c.us', { savedStatus: 'saved' }), member('2@c.us', { savedStatus: 'unknown' }), member('3@c.us', { pushname: '' }), member('4@c.us'), member('5@c.us')], [member('4@s.whatsapp.net')]);
  const result = await selectCandidates(b, store, rules, 10);
  assert.deepEqual(result.candidates.map(c => c.id), ['5@c.us']);
  assert.equal(result.completeArchive, false);
  assert.equal(result.skipped.length, 4);
});
test('previous outbound history and campaign journal exclude recipients', async t => {
  const { store } = fixture(t);
  const result = await selectCandidates(backend(undefined, [], [{ fromMe: true, body: 'hello' }]), store, rules, 10);
  assert.equal(result.candidates.length, 0);
  const d = store.create(rules, [recipient]); approve(store, d); await store.execute(d.id, backend(), async () => {});
  assert.equal((await selectCandidates(backend(), store, rules, 10)).candidates.length, 0);
});
test('excluded group fetch failures and unresolved identities fail closed', async t => {
  const { store } = fixture(t);
  const b = backend([], [{ ...member('1@lid'), identityResolved: false }]);
  await assert.rejects(selectCandidates(b, store, rules, 10), /unresolved/);
  b.getGroupMembers = async () => { throw new Error('cannot fetch'); };
  await assert.rejects(selectCandidates(b, store, rules, 10));
});
test('corrupt or edited journals are not silently reset', t => {
  const { store, file } = fixture(t); const d = store.create(rules, [recipient]);
  const data = JSON.parse(readFileSync(file, 'utf8')); data.drafts[d.id].recipients[0].steps[0].text = 'tampered';
  writeFileSync(file, JSON.stringify(data));
  assert.throws(() => new CampaignStore(file), /digest/);
});
test('group destinations, duplicate aliases, invalid media and empty batches are rejected', t => {
  const { store } = fixture(t);
  assert.throws(() => store.create(rules, []));
  assert.throws(() => store.create(rules, [{ ...recipient, id: 'x@g.us' }]));
  assert.throws(() => store.create(rules, [recipient, { ...recipient, id: '123@s.whatsapp.net' }]));
  assert.throws(() => store.create(rules, [{ ...recipient, steps: [{ kind: 'image', base64: 'aGVsbG8=', mime: 'image/png' }] }]));
});
test('all upstream send methods are blocked while reads retain this binding', async () => {
  const raw = { value: 7, getStatus() { return this.value; }, sendMessage() { throw new Error('should not reach'); } };
  const wrapped = readOnlyBackend(raw);
  assert.equal(wrapped.getStatus(), 7);
  for (const method of ['sendMessage', 'sendMedia', 'sendMediaFromBase64', 'sendVoiceNote']) await assert.rejects(wrapped[method](), /Direct sends are disabled/);
});
test('owner authentication rejects missing, short and incorrect credentials', () => {
  const secret = 'x'.repeat(48);
  const header = value => `Basic ${Buffer.from(value).toString('base64')}`;
  assert.equal(checkOwnerHeader(header(`owner:${secret}`), secret), true);
  assert.equal(checkOwnerHeader(header(`owner:${secret}`), 'short'), false);
  assert.equal(checkOwnerHeader(undefined, secret), false);
  assert.equal(checkOwnerHeader(header('owner:wrong'), secret), false);
});
