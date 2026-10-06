import { Router, urlencoded } from 'express';
import { CampaignStore } from '../services/campaigns.js';

const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
/** Mount ONLY behind ownerGuard. Approval is intentionally unavailable to MCP tools. */
export function campaignRouter(store: CampaignStore, origin: string): Router {
  const router = Router();
  router.use(urlencoded({ extended: false, limit: '4kb' }));
  router.get('/:id', (req, res) => {
    try {
      const d = store.get(String(req.params.id));
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      const recipients = d.recipients.map(r => `<section><h2>${escape(r.displayName)} — ${escape(r.id)}</h2>${r.steps.map(s => s.kind === 'text' ? `<pre>${escape(s.text)}</pre>` : `<img style="max-width:320px" alt="Invitation image" src="data:${s.mime};base64,${s.base64}"><pre>${escape(s.caption ?? '')}</pre>`).join('')}</section>`).join('');
      res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Approve WhatsApp messages</title></head><body style="font-family:system-ui;max-width:760px;margin:24px auto;padding:16px"><h1>Review ${d.recipients.length} recipients</h1><p>Campaign: ${escape(d.rules.campaign)}. Status: ${escape(d.status)}.</p><p>Only available synchronized history has been searched. Earlier invitations may be missing. This approval authorizes exactly the messages below for 15 minutes.</p>${recipients}${d.status === 'draft' ? `<form method="post" action="/campaigns/${d.id}/approve"><input type="hidden" name="csrf" value="${d.csrf}"><input type="hidden" name="digest" value="${d.digest}"><label><input type="checkbox" name="reviewed" value="yes" required>I have reviewed every recipient and message, including the incomplete-history limitation.</label><p><button>Approve these exact messages</button></p></form>` : '<p>This draft cannot be approved again.</p>'}</body></html>`);
    } catch { res.status(404).send('Draft unavailable.'); }
  });
  router.post('/:id/approve', (req, res) => {
    if (req.headers.origin !== origin || req.body?.reviewed !== 'yes') { res.status(403).send('Review and submit from the approval page.'); return; }
    try {
      store.approve(String(req.params.id), String(req.body.csrf ?? ''), String(req.body.digest ?? ''));
      res.send('Approved for 15 minutes. Return to ChatGPT to execute this draft. Nothing has been sent yet.');
    } catch { res.status(409).send('Invalid, expired, or already used approval.'); }
  });
  return router;
}
