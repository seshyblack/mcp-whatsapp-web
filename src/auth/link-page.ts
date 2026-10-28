import { Router, Request, Response } from 'express';
import qrcode from 'qrcode';
import { WhatsAppOAuthProvider } from './oauth-provider.js';
import type { WhatsAppBackend } from '../services/backend.js';
import { log } from '../utils/logger.js';

const TXN_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

/**
 * Browser-facing part of the OAuth flow: the page a user lands on during
 * authorization. It shows the live WhatsApp QR code (and optionally a
 * pairing-code form) and polls until the WhatsApp client is authenticated,
 * then forwards the browser to /oauth/link/complete which redirects back to
 * the MCP client with the authorization code.
 */
export function createLinkRouter(
  provider: WhatsAppOAuthProvider,
  whatsapp: WhatsAppBackend,
  origin: string,
): Router {
  const router = Router();

  const validTxn = (req: Request, res: Response): string | null => {
    const txn = String(req.query.txn ?? req.body?.txn ?? '');
    if (!TXN_PATTERN.test(txn) || !provider.getTransaction(txn)) {
      res.status(400).send('Unknown or expired authorization request. Please retry from your MCP client.');
      return null;
    }
    return txn;
  };

  router.get('/', (req: Request, res: Response) => {
    if (!validTxn(req, res)) return;
    res.type('html').send(LINK_PAGE_HTML);
  });

  router.get('/status', async (req: Request, res: Response) => {
    const txn = validTxn(req, res);
    if (!txn) return;

    const authenticated = whatsapp.isAuthenticated();
    const qrString = whatsapp.getLatestQrCode();
    const connectionError = whatsapp.getStatus().connectionError ?? null;
    const pending = provider.getTransaction(txn)!;
    res.json({
      authenticated,
      connectionError,
      csrf: pending.csrf,
      clientName: pending.client.client_name ?? pending.client.client_id,
      redirectUri: pending.params.redirectUri,
      qrDataUrl: !authenticated && qrString ? await qrcode.toDataURL(qrString) : null,
      pairingCode: !authenticated ? whatsapp.getLatestPairingCode() : null,
    });
  });

  router.post('/pair', async (req: Request, res: Response) => {
    if (req.headers.origin !== origin) { res.status(403).send('Invalid origin.'); return; }
    const txn = validTxn(req, res);
    if (!txn) return;

    try {
      const code = await whatsapp.requestPairingCode(String(req.body?.phone_number ?? ''));
      res.json({ pairingCode: code });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Authenticated owner can restart a stuck unauthenticated backend without
  // deleting its persisted session database or history.
  router.post('/retry', async (req: Request, res: Response) => {
    if (req.headers.origin !== origin) { res.status(403).send('Invalid origin.'); return; }
    if (!validTxn(req, res)) return;
    try {
      if (!whatsapp.isAuthenticated()) {
        await whatsapp.destroy();
        await whatsapp.initialize();
      }
      res.json({ ok: true });
    } catch (error) {
      log.warn('Failed to restart WhatsApp pairing:', error);
      res.status(503).json({ error: 'WhatsApp could not restart pairing. Check the hosting service logs.' });
    }
  });

  router.post('/complete', (req: Request, res: Response) => {
    if (req.headers.origin !== origin) { res.status(403).send('Invalid origin.'); return; }
    const txn = validTxn(req, res);
    if (!txn) return;

    try {
      res.json({ redirectUrl: provider.completeTransaction(txn, String(req.body?.csrf ?? '')) });
    } catch (error) {
      log.warn('Failed to complete OAuth transaction:', error);
      res.status(409).send(error instanceof Error ? error.message : String(error));
    }
  });

  return router;
}

const LINK_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link WhatsApp</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, sans-serif; margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: #f5f5f5; color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) { body { background: #191919; color: #eee; } }
  .card {
    background: #fff; border-radius: 12px; padding: 2rem; max-width: 24rem;
    box-shadow: 0 2px 12px rgba(0,0,0,.12); text-align: center;
  }
  @media (prefers-color-scheme: dark) { .card { background: #262626; } }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  p { font-size: .9rem; opacity: .8; }
  #qr img { width: 240px; height: 240px; border-radius: 8px; background: #fff; }
  #pairing-code { font-size: 1.6rem; font-weight: 700; letter-spacing: .2em; margin: .5rem 0; }
  form { margin-top: 1rem; display: flex; gap: .5rem; justify-content: center; }
  input {
    padding: .5rem .7rem; border-radius: 6px; border: 1px solid #8884;
    background: transparent; color: inherit; width: 12rem;
  }
  button {
    padding: .5rem .9rem; border-radius: 6px; border: none; cursor: pointer;
    background: #25d366; color: #fff; font-weight: 600;
  }
  .error { color: #d33; font-size: .85rem; }
  .ok { color: #25d366; font-weight: 600; }
  details { margin-top: 1.2rem; font-size: .85rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Link your WhatsApp account</h1>
  <div id="content"><p>Waiting for QR code&hellip;</p></div>
  <div id="repair" hidden>
    <p id="repair-text"></p>
    <button type="button" id="retry-button">Restart WhatsApp connection</button>
  </div>
  <details>
    <summary>Use a pairing code instead</summary>
    <p>Enter your WhatsApp phone number in international format (e.g. 4915112345678):</p>
    <form id="pair-form">
      <input id="phone" type="tel" placeholder="4915112345678" required>
      <button type="submit">Get code</button>
    </form>
    <p id="pair-result"></p>
  </details>
</div>
<script>
  const txn = new URLSearchParams(location.search).get('txn');
  const content = document.getElementById('content');
  let pairingActive = false;

  const repair = document.getElementById('repair');
  const repairText = document.getElementById('repair-text');
  const retryButton = document.getElementById('retry-button');
  let firstPollAt = Date.now();
  let pollFailures = 0;
  let finished = false;

  function offerRetry(message) {
    repair.hidden = false;
    repairText.textContent = message;
  }

  async function poll() {
    const controller = new AbortController();
    const abortAfter = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/oauth/link/status?txn=' + encodeURIComponent(txn), {
        signal: controller.signal, cache: 'no-store',
      });
      if (res.status === 400) {
        content.textContent = 'This authorization request expired. Retry from your MCP client.';
        finished = true;
        return;
      }
      if (!res.ok) throw new Error('Status endpoint unavailable');
      pollFailures = 0;
      const s = await res.json();
      if (s.authenticated) {
        finished = true;
        repair.hidden = true;
        content.replaceChildren();
        const summary = document.createElement('p');
        summary.textContent = 'Authorize ' + s.clientName + ' to access your WhatsApp MCP? Return address: ' + s.redirectUri;
        const button = document.createElement('button');
        button.textContent = 'Authorize this client';
        button.onclick = async () => {
          button.disabled = true;
          const result = await fetch('/oauth/link/complete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txn, csrf: s.csrf }),
          });
          if (!result.ok) { summary.textContent = 'Authorization failed or expired. Restart from your MCP client.'; return; }
          location.href = (await result.json()).redirectUrl;
        };
        content.append(summary, button);
        return;
      }
      if (s.pairingCode) {
        content.textContent = 'Enter this pairing code on your phone (WhatsApp > Linked Devices > Link a device > Link with phone number instead):';
        const code = document.createElement('div');
        code.id = 'pairing-code';
        code.textContent = s.pairingCode;
        content.append(code);
        repair.hidden = true;
      } else if (s.qrDataUrl && !pairingActive) {
        content.textContent = 'Scan this QR code from WhatsApp > Linked Devices > Link a device:';
        const wrapper = document.createElement('div');
        wrapper.id = 'qr';
        const img = document.createElement('img');
        img.alt = 'WhatsApp QR code';
        img.src = s.qrDataUrl;
        wrapper.append(img);
        content.append(wrapper);
        repair.hidden = true;
      } else if (s.connectionError) {
        content.textContent = 'WhatsApp could not start pairing.';
        offerRetry(s.connectionError);
      } else if (Date.now() - firstPollAt >= 12000) {
        content.textContent = 'No QR code has arrived. Request a phone-number code below or restart the connection.';
        offerRetry('The WhatsApp service has not yet received a login challenge.');
      }
    } catch (error) {
      if (++pollFailures >= 2) {
        content.textContent = 'Unable to reach the WhatsApp login service.';
        offerRetry('The server is not responding reliably. Try restarting the WhatsApp connection.');
      }
    } finally {
      clearTimeout(abortAfter);
      if (!finished) setTimeout(poll, 2000);
    }
  }
  poll();

  retryButton.addEventListener('click', async () => {
    retryButton.disabled = true;
    repairText.textContent = 'Restarting WhatsApp connection…';
    try {
      const res = await fetch('/oauth/link/retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txn }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Restart failed.');
      }
      firstPollAt = Date.now();
      repairText.textContent = 'Restarted. A QR code or phone-number pairing code should appear shortly.';
    } catch (error) {
      repairText.textContent = error instanceof Error ? error.message : 'Restart failed.';
    } finally {
      retryButton.disabled = false;
    }
  });

  document.getElementById('pair-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = document.getElementById('pair-result');
    out.textContent = 'Requesting code…';
    try {
      const res = await fetch('/oauth/link/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txn, phone_number: document.getElementById('phone').value }),
      });
      const data = await res.json();
      if (res.ok) { pairingActive = true; out.textContent = 'Pairing code: ' + data.pairingCode + '. Enter it on WhatsApp under Linked Devices.'; }
      else { out.textContent = data.error || 'Failed to request pairing code.'; out.className = 'error'; }
    } catch (e) { out.textContent = 'Failed to request pairing code.'; out.className = 'error'; }
  });
</script>
</body>
</html>`;

