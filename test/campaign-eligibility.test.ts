
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CampaignStore, selectCandidates, verifyCampaignRecipients } from '../src/services/campaigns.js';

const rules = {
  sourceGroup: 'mcm@g.us', excludeGroups: [], campaign: 'Calmistry auction',
  markers: ['auction'], excludeAnyPreviousOutbound: true,
};
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'calmistry-unsaved-'));
  directories.push(dir);
  return new CampaignStore(path.join(dir, 'campaigns.json'));
}
function unsaved(phone: string) {
  return { id: phone + '@s.whatsapp.net', aliases: [], identityResolved: true, contact: null };
}
function withContact(phone: string, extras: Record<string, unknown> = {}) {
  return {
    ...unsaved(phone),
    contact: {
      id: phone + '@s.whatsapp.net', isUser: true, isMe: false,
      isMyContact: false, savedStatus: 'unsaved', pushname: '', name: null, number: phone,
      ...extras,
    },
  };
}
function backend(members: any[], messages: any[] = []) {
  return {
    getStatus: () => ({ authenticated: true, history: { state: 'available' } }),
    getGroupMembers: async (id: string) => id === rules.sourceGroup ? members : [],
    getMessages: async () => messages,
  } as any;
}

describe('Calmistry outreach to unsaved group members', () => {
  it('accepts verified MCM members without contact records or names', async () => {
    const s = store();
    const b = backend([unsaved('60197190114'), withContact('60165781108', { savedStatus: 'unknown' })]);
    const selected = await selectCandidates(b, s, rules, 2);
    expect(selected.candidates).toEqual([
      expect.objectContaining({ id: '60197190114@s.whatsapp.net', displayName: '+60197190114', firstName: '' }),
      expect.objectContaining({ id: '60165781108@s.whatsapp.net', displayName: '+60165781108', firstName: '' }),
    ]);
    await expect(verifyCampaignRecipients(b, s, rules, selected.candidates)).resolves.toBeUndefined();
  });
  it('rejects positively known saved contacts and invalid identities', async () => {
    const s = store();
    const b = backend([
      withContact('6583998032', { isMyContact: true }),
      withContact('60165781108', { savedStatus: 'saved' }),
      { ...unsaved('60182540780'), identityResolved: false },
      { ...unsaved('60127120144'), id: '123@lid' },
      withContact('60138222255', { isMe: true }),
    ]);
    const selected = await selectCandidates(b, s, rules, 10);
    expect(selected.candidates).toHaveLength(0);
    expect(selected.skipped).toHaveLength(5);
  });
  it('excludes prior one-to-one messages and recorded completed campaigns', async () => {
    const s = store();
    const m = unsaved('60197190114');
    const prior = await selectCandidates(backend([m], [{ type: 'chat', body: 'Hello', hasMedia: false }]), s, rules, 1);
    expect(prior.candidates).toHaveLength(0);
    const draft = s.create(rules, [{
      id: m.id, displayName: '+60197190114', steps: [{ kind: 'text' as const, text: 'Calmistry invitation' }],
    }]);
    s.approve(draft.id, draft.csrf, draft.digest);
    await s.execute(draft.id, { sendMessage: async () => ({ id: 'sent-1' }) } as any, async () => {});
    const later = await selectCandidates(backend([m]), s, rules, 1);
    expect(later.candidates).toHaveLength(0);
    expect(later.skipped[0].reason).toBe('prior_campaign_outreach');
  });
  it('validates target recipients beyond the first 25 candidate results', async () => {
    const s = store();
    const many = Array.from({ length: 40 }, (_, i) => unsaved(String(60180000000 + i)));
    const b = backend(many);
    const first = await selectCandidates(b, s, rules, 25);
    const target = many[37]!;
    expect(first.candidates.some(c => c.id === target.id)).toBe(false);
    await expect(verifyCampaignRecipients(b, s, rules, [{
      id: target.id, displayName: '+' + target.id.split('@')[0],
    }])).resolves.toBeUndefined();
  });
  it('fails closed for nonmembers and earlier image messages', async () => {
    const s = store();
    const m = unsaved('60197190114');
    await expect(verifyCampaignRecipients(backend([m]), s, rules, [{
      id: '60165781108@s.whatsapp.net', displayName: '+60165781108',
    }])).rejects.toThrow(/not in source group/);
    await expect(verifyCampaignRecipients(backend([m], [
      { type: 'image', body: '', hasMedia: true },
    ]), s, rules, [{
      id: m.id, displayName: '+60197190114',
    }])).rejects.toThrow(/prior_direct_interaction/);
  });
});
