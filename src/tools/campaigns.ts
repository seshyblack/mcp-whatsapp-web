import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { WhatsAppBackend } from '../services/backend.js';
import { CampaignStore, canonical, redactDraft, selectCandidates, type Draft } from '../services/campaigns.js';

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
  server.registerTool('select_campaign_candidates', { description: 'Find proposed recipients, excluding saved/unknown contacts, excluded groups, missing names, unresolved identities and previous outbound messages. May return fewer than requested. Show every proposed recipient to the user.', inputSchema: { rules: rulesSchema, count: z.number().int().min(1).max(25) }, annotations: read }, ({ rules, count }) => run(() => selectCandidates(backend, store, rules, count)));

  const recheck = async (draft: Pick<Draft, 'rules' | 'recipients'>) => {
    const result = await selectCandidates(backend, store, draft.rules, 25);
    for (const r of draft.recipients) {
      const candidate = result.candidates.find(c => canonical(c.id) === canonical(r.id));
      if (!candidate || candidate.displayName !== r.displayName) throw new Error(`Recipient eligibility/name changed or cannot be confirmed: ${r.id}`);
    }
  };
  server.registerTool('preview_campaign_batch', { description: 'Persist an immutable draft with exact personalized text/image/URL-as-text steps. Sends nothing. Show all recipients and messages; the owner must approve through the protected browser page.', inputSchema: { rules: rulesSchema, recipients: z.array(z.object({ id: z.string(), displayName: z.string().min(1).max(200), steps: z.array(stepSchema).min(1).max(5) })).min(1).max(25) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, ({ rules, recipients }) => run(async () => {
    await recheck({ rules, recipients });
    const d = store.create(rules, recipients);
    return { ...redactDraft(d), approvalUrl: publicUrl ? new URL(`/campaigns/${d.id}`, publicUrl).href : null, note: 'No send authorization exists until the owner approves this exact draft.' };
  }));
  server.registerTool('get_campaign_batch', { description: 'Read a draft and its send journal. An uncertain batch must never be automatically retried.', inputSchema: { id: z.string().uuid() }, annotations: { ...read, openWorldHint: false } }, ({ id }) => run(async () => redactDraft(store.get(id))));
  server.registerTool('execute_approved_batch', { description: 'Send only a previously owner-approved immutable draft. Requires explicit user authorization for these recipients/messages. Rechecks eligibility and records sends. Never retry uncertain batches.', inputSchema: { id: z.string().uuid() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, ({ id }) => run(async () => redactDraft(await store.execute(id, backend, recheck))));
}
