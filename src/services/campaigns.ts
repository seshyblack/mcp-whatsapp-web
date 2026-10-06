import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WhatsAppBackend, SimpleContact } from './backend.js';

export type Step = { kind: 'text'; text: string } | { kind: 'image'; base64: string; mime: 'image/png' | 'image/jpeg'; caption?: string };
export interface Recipient { id: string; displayName: string; steps: Step[] }
export interface Rules { sourceGroup: string; excludeGroups: string[]; campaign: string; markers: string[]; excludeAnyPreviousOutbound: boolean }
export interface Draft {
  id: string; createdAt: number; expiresAt: number; rules: Rules; recipients: Recipient[];
  digest: string; csrf: string; status: 'draft' | 'approved' | 'sending' | 'sent' | 'uncertain';
  approvedUntil?: number; results: Array<{ recipient: string; step: number; messageId: string }>;
}
export interface CampaignState { version: 1; drafts: Record<string, Draft> }

export function canonical(id: string): string { return id.replace(/@c\.us$/, '@s.whatsapp.net'); }
export function contactName(contact: SimpleContact | null): string | null {
  const name = (contact?.pushname || contact?.name || '').trim();
  return name && !/^[+\d\s()-]+$/.test(name) ? name : null;
}
export function redactDraft(draft: Draft) {
  const { csrf: _csrf, ...preview } = structuredClone(draft);
  return preview;
}
function digest(rules: Rules, recipients: Recipient[]): string {
  return createHash('sha256').update(JSON.stringify({ rules, recipients })).digest('hex');
}
export function secretMatches(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Atomic local journal; sending is persisted BEFORE the network call. Never automatically retry an uncertain send. */
export class CampaignStore {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) this.locked(() => {
      if (!existsSync(file)) this.save({ version: 1, drafts: {} });
    });
    this.read();
  }
  private read(): CampaignState {
    const state = JSON.parse(readFileSync(this.file, 'utf8')) as CampaignState;
    if (state.version !== 1 || !state.drafts || typeof state.drafts !== 'object') throw new Error('Invalid campaign journal; refusing to reset it.');
    for (const d of Object.values(state.drafts)) if (d.digest !== digest(d.rules, d.recipients)) throw new Error('Campaign journal digest mismatch.');
    return state;
  }
  private locked<T>(work: () => T): T {
    const lock = `${this.file}.sending.lock`;
    const fd = openSync(lock, 'wx', 0o600);
    try { return work(); } finally { closeSync(fd); unlinkSync(lock); }
  }
  private save(state: CampaignState): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.file);
    const dir = openSync(path.dirname(this.file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  get(id: string): Draft {
    const draft = this.read().drafts[id];
    if (!draft) throw new Error('Unknown draft.');
    return structuredClone(draft);
  }
  contacted(id: string, campaign?: string): boolean {
    return Object.values(this.read().drafts).some(d => (!campaign || d.rules.campaign === campaign)
      && ['sending', 'sent', 'uncertain'].includes(d.status)
      && d.recipients.some(r => canonical(r.id) === canonical(id)));
  }
  create(rules: Rules, recipients: Recipient[]): Draft {
    if (!rules.excludeAnyPreviousOutbound && !rules.markers.some(s => s.trim())) throw new Error('Campaign markers are required when earlier outbound messages are allowed.');
    if (!rules.campaign.trim() || !rules.sourceGroup.endsWith('@g.us') || rules.excludeGroups.some(g => !g.endsWith('@g.us'))) throw new Error('Invalid campaign/group rules.');
    if (!recipients.length || recipients.length > 25) throw new Error('A draft must have 1–25 recipients.');
    const ids = new Set<string>();
    let totalMedia = 0;
    for (const r of recipients) {
      if (!/^\d+@(c\.us|s\.whatsapp\.net)$/.test(r.id) || ids.has(canonical(r.id))) throw new Error('Recipient identity must be resolved and unique.');
      ids.add(canonical(r.id));
      if (!r.displayName.trim() || r.steps.length < 1 || r.steps.length > 5) throw new Error('Name and 1–5 steps required.');
      for (const step of r.steps) {
        if (step.kind === 'text') {
          if (!step.text.trim() || step.text.length > 10000) throw new Error('Invalid text step.');
        } else if (step.kind === 'image') {
          if (!['image/png', 'image/jpeg'].includes(step.mime) || !/^[A-Za-z0-9+/]+={0,2}$/.test(step.base64)) throw new Error('Invalid image.');
          const bytes = Buffer.from(step.base64, 'base64');
          const valid = step.mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
          totalMedia += bytes.length;
          if (!valid || bytes.length > 2 * 1024 * 1024 || totalMedia > 8 * 1024 * 1024 || (step.caption?.length ?? 0) > 10000) throw new Error('Invalid or oversized image batch.');
        } else throw new Error('Unknown message step.');
      }
    }
    const now = Date.now();
    const d: Draft = { id: randomUUID(), createdAt: now, expiresAt: now + 86400000,
      rules: structuredClone(rules), recipients: structuredClone(recipients), digest: digest(rules, recipients),
      csrf: randomBytes(32).toString('hex'), status: 'draft', results: [] };
    this.locked(() => { const state = this.read(); state.drafts[d.id] = d; this.save(state); });
    return this.get(d.id);
  }
  /** Called only by the owner-authenticated browser form, never exposed as an MCP tool. */
  approve(id: string, csrf: string, reviewedDigest: string): void {
    this.locked(() => {
    const state = this.read();
    const d = state.drafts[id];
    if (!d || d.status !== 'draft' || d.expiresAt <= Date.now() || !secretMatches(csrf, d.csrf) || reviewedDigest !== d.digest) throw new Error('Approval is invalid or expired.');
    d.status = 'approved'; d.approvedUntil = Date.now() + 15 * 60000; this.save(state);
    });
  }
  async execute(id: string, backend: WhatsAppBackend, recheck: (draft: Draft) => Promise<void>): Promise<Draft> {
    // A filesystem lock also excludes other processes sharing this journal.
    const lock = `${this.file}.sending.lock`;
    const fd = openSync(lock, 'wx', 0o600);
    try {
      const state = this.read();
      const d = state.drafts[id];
      if (!d || d.status !== 'approved' || (d.approvedUntil ?? 0) <= Date.now() || d.digest !== digest(d.rules, d.recipients)) throw new Error('Exact draft must be approved by the owner first.');
      await recheck(this.get(id));
      if ((d.approvedUntil ?? 0) <= Date.now()) throw new Error('Approval expired during checks.');
      d.status = 'sending'; this.save(state);
      try {
        for (const r of d.recipients) {
          for (let i = 0; i < r.steps.length; i++) {
            const step = r.steps[i]!;
            const sent = step.kind === 'text' ? await backend.sendMessage(r.id, step.text)
              : await backend.sendMediaFromBase64(r.id, step.base64, step.mime, 'invitation', step.caption);
            d.results.push({ recipient: r.id, step: i, messageId: sent.id }); this.save(state);
          }
        }
        d.status = 'sent'; this.save(state);
      } catch (error) { d.status = 'uncertain'; this.save(state); throw error; }
      return this.get(id);
    } finally { closeSync(fd); unlinkSync(lock); }
  }
}

export async function selectCandidates(backend: WhatsAppBackend, _store: CampaignStore, rules: Rules, count: number) {
  if (!backend.getGroupMembers) throw new Error('Backend does not expose group participants.');
  if (!Number.isInteger(count) || count < 1 || count > 25) throw new Error('Choose 1–25 recipients.');
  const status = backend.getStatus();
  if (!status.authenticated || status.history.state !== 'available') throw new Error('Wait for authentication and history synchronization.');

  // Eligibility is intentionally limited to the owner's four requested rules:
  // 1) verified member of sourceGroup, 2) resolved WhatsApp identity,
  // 3) not already in the owner's contacts, 4) no meaningful prior 1:1 interaction
  // in the synchronized history.
  const members = await backend.getGroupMembers(rules.sourceGroup);
  const candidates: Array<{ id: string; displayName: string; firstName: string; historyCoverage: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();

  const isMeaningful = (msg: { type: string; body: string; hasMedia: boolean }) => {
    const type = (msg.type || '').toLowerCase();
    if (['unknown', 'protocol', 'placeholder', 'secretencrypted'].includes(type)) return false;
    return Boolean((msg.body || '').trim() || msg.hasMedia || [
      'chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker',
      'reaction', 'call_log', 'template', 'interactive',
    ].includes(type));
  };

  for (const m of members) {
    const id = canonical(m.id);
    if (seen.has(id)) continue;
    seen.add(id);

    let reason = '';
    if (!m.identityResolved) reason = 'unresolved_identity';
    else if (!m.contact?.isUser || m.contact.isMe) reason = 'not_another_user';
    else if (m.contact.isMyContact !== false) reason = 'already_in_contacts';
    else {
      const messages = await backend.getMessages(m.id, 1000);
      if (messages.some(isMeaningful)) reason = 'prior_direct_interaction';
    }

    if (reason) {
      skipped.push({ id: m.id, reason });
    } else {
      const displayName = contactName(m.contact) || (m.contact?.number ? `+${m.contact.number}` : id.split('@')[0]!);
      const firstName = contactName(m.contact)?.split(/\s+/)[0] || '';
      candidates.push({
        id: m.id,
        displayName,
        firstName,
        historyCoverage: 'Only synchronized history was searched; no meaningful prior 1:1 interaction was found.',
      });
    }

    if (candidates.length >= count || seen.size >= 300) break;
  }

  return {
    candidates,
    skipped,
    scanned: seen.size,
    requested: count,
    completeArchive: false,
    note: 'Eligibility uses only source-group membership, resolved identity, isMyContact=false, and no meaningful prior 1:1 interaction in synchronized history.',
  };
}
