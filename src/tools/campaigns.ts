import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { WhatsAppBackend } from '../services/backend.js';
import { CampaignStore, redactDraft, selectCandidates, verifyCampaignRecipients, type Draft } from '../services/campaigns.js';

const rulesSchema = z.object({
  sourceGroup: z.string().endsWith('@g.us'), excludeGroups: z.array(z.string().endsWith('@g.us')).max(20),
  campaign: z.string().min(1).max(100), markers: z.array(z.string().min(1).max(500)).max(20),
  excludeAnyPreviousOutbound: z.boolean().default(true),
});
const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(10000) }),
  z.object({ kind: z.literal('image'), base64: z.string().max(3 * 1024 * 1024), mime: z.enum(['image/png', 'image/jpeg']), caption: z.string().max(10000).optional() }),
]);
const answer = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const run = async (work: () => Promise<unknown>): Promise<CallToolResult> => {
  try { return answer(await work()); } catch (e) { return { ...answer({ error: e instanceof Error ? e.message : String(e) }), isError: true }; }
};
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

export function registerCampaignTools(server: McpServer, backend: WhatsAppBackend, store: CampaignStore, publicUrl?: string): void {
  server.registerTool('search_chats', { description: 'Search names among up to 1000 synchronized chats. Resolve exact group IDs before using exclusions.', inputSchema: { query: z.string().max(200) }, annotations: read }, ({ query }) => run(async () => ({ chats: (await backend.listChats(1000, false)).filter(c => c.name.toLowerCase().includes(query.toLowerCase())), exhaustive: false })));
  server.registerTool('list_group_members', { description: 'Get group participants and names exposed by the linked session. savedStatus unknown must not be interpreted as unsaved.', inputSchema: { groupId: z.string().endsWith('@g.us') }, annotations: read }, ({ groupId }) => run(async () => {
    if (!backend.getGroupMembers) throw new Error('Group membership unavailable.');
    return backend.getGroupMembers(groupId);
  }));
  server.registerTool('search_chat_history', { description: 'Search up to 1000 available messages. No match does not prove absence from the full account history.', inputSchema: { chatId: z.string(), query: z.string().min(1).max(500) }, annotations: read }, ({ chatId, query }) => run(async () => ({ messages: (await backend.getMessages(chatId, 1000)).filter(m => m.body.toLowerCase().includes(query.toLowerCase())), completeArchive: false })));
  // Follow-up selection is intentionally separate from cold-outreach eligibility.
  // Read-only preview: no sending, approvals, scheduling or recipient mutation.
  server.registerTool('preview_auction_positive_followups', {
    description: 'Preview Calmistry auction contacts who replied positively to a previous personal invitation. Reads bounded recent chats, excludes bidders/declines/previous closing reminders; never sends. Owner verifies exact recipients before a follow-up.',
    inputSchema: {
      max_chats: z.number().int().min(1).max(120).default(80),
      limit: z.number().int().min(1).max(30).default(25),
    },
    annotations: read,
  }, ({ max_chats, limit }) => run(async () => {
    const cutoff = Date.parse('2026-11-08T00:00:00+08:00') / 1000;
    const chats = (await backend.listChats(1000, false))
      .filter(c => !c.isGroup && /^\\d+@(s\\.whatsapp\\.net|lid)$/.test(c.id)
        && c.timestamp >= cutoff)
      .slice(0, max_chats);
    const candidates: Array<{ chatId: string; name: string; repliedAt: string; positiveReply: string }> = [];
    let reviewed = 0;
    let unavailable = 0;
    for (const chat of chats) {
      if (candidates.length >= limit) break;
      let messages;
      try { messages = await backend.getMessages(chat.id, 25); }
      catch { unavailable++; continue; }
      reviewed++;
      const ordered = messages.filter(m => m.timestamp >= cutoff && m.type !== 'call_log')
        .sort((a, b) => a.timestamp - b.timestamp);
      if (ordered.some(m => /(?:\\*NEW BID|BID RECEIVED|OUTBID|Bid Lot\\s*\\d{1,2}|BID ALREADY RECORDED)/i.test(m.body))) continue;
      const invitation = [...ordered].reverse().find(m => m.fromMe
        && /(?:calmistry\\.space|private auction|calmistry.*auction|auction ends)/i.test(m.body)
        && !/(?:reminder|closes.*9\\s*p\\.?m)/i.test(m.body));
      if (!invitation) continue;
      const replies = ordered.filter(m => !m.fromMe && m.timestamp >= invitation.timestamp);
      if (!replies.length) continue;
      const latest = replies[replies.length - 1]!;
      if (/(?:not interested|not keen|please stop|unsubscribe|don't message|do not message|no thanks|won't be able)/i.test(latest.body)) continue;
      const positive = replies.find(m =>
        /(?:i(?:'|’)ll (?:have a look|take a look|check)|i will (?:have a look|take a look|check)|will check|will (?:take|have) a look|yes(?:,| )? sure|sure,? (?:will|i(?:'|’)ll)|i(?:'|’)d love|sounds (?:great|good|interesting)|interested|when (?:are you|can i)|where (?:is|are)|how (?:do i|can i))/i.test(m.body));
      if (!positive) continue;
      const reminder = ordered.some(m => m.fromMe && m.timestamp > positive.timestamp
        && /(?:little reminder|final reminder|auction closes.*9\\s*p\\.?m|ends.*sunday.*9\\s*p\\.?m)/i.test(m.body));
      if (reminder) continue;
      candidates.push({
        chatId: chat.id, name: chat.name || chat.id.split('@')[0]!,
        repliedAt: new Date(positive.timestamp * 1000).toISOString(),
        positiveReply: positive.body.slice(0, 200),
      });
    }
    return {
      candidates, scannedChats: chats.length, readChats: reviewed, unavailableChats: unavailable,
      completeArchive: false, noMessagesSent: true,
      note: 'Preview only. Positive responses are heuristic, and only synchronized recent history was reviewed. Verify all conversations and exclude opt-outs before sending; do not reuse cold-outreach campaign rules.',
    };
  }));

  server.registerTool('select_campaign_candidates', { description: 'Find verified group members, including people without saved contacts or names. Excludes known saved contacts, unresolved identities and earlier direct outreach. Show every proposed recipient.', inputSchema: { rules: rulesSchema, count: z.number().int().min(1).max(25) }, annotations: read }, ({ rules, count }) => run(() => selectCandidates(backend, store, rules, count)));

  const recheck = async (draft: Pick<Draft, 'rules' | 'recipients'>) =>
    verifyCampaignRecipients(backend, store, draft.rules, draft.recipients);
  server.registerTool('preview_campaign_batch', { description: 'Persist an immutable draft with exact personalized text/image/URL-as-text steps. Sends nothing. Show all recipients and messages; the owner must approve through the protected browser page.', inputSchema: { rules: rulesSchema, recipients: z.array(z.object({ id: z.string(), displayName: z.string().min(1).max(200), steps: z.array(stepSchema).min(1).max(5) })).min(1).max(25) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, ({ rules, recipients }) => run(async () => {
    await recheck({ rules, recipients });
    const d = store.create(rules, recipients);
    store.approveFromChat(d.id);
    const approved = store.get(d.id);
    return { ...redactDraft(approved), approvalUrl: publicUrl ? new URL(`/campaigns/${d.id}`, publicUrl).href : null, note: 'This exact immutable draft is authorized for 15 minutes by the owner\'s explicit chat instruction.' };
  }));
  server.registerTool('get_campaign_batch', { description: 'Read a draft and its send journal. An uncertain batch must never be automatically retried.', inputSchema: { id: z.string().uuid() }, annotations: { ...read, openWorldHint: false } }, ({ id }) => run(async () => redactDraft(store.get(id))));
  server.registerTool('execute_approved_batch', { description: 'Send only a previously owner-approved immutable draft. Requires explicit user authorization for these recipients/messages. Rechecks eligibility and records sends. Never retry uncertain batches.', inputSchema: { id: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, ({ id }) => run(async () => redactDraft(await store.execute(id, backend, recheck))));
}
