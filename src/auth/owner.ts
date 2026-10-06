import type { RequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

export function checkOwnerHeader(header: string | undefined, secret: string): boolean {
  if (secret.length < 32 || !header?.startsWith('Basic ') || header.length > 2048) return false;
  const supplied = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(supplied), hash(`owner:${secret}`));
}

export function ownerGuard(secret: string): RequestHandler {
  if (secret.length < 32) throw new Error('MCP_OWNER_SECRET must have at least 32 characters.');
  // Globally bounded login attempts avoid depending on spoofable proxy IP headers.
  let failures = 0; let windowStart = Date.now();
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (Date.now() - windowStart > 60000) { failures = 0; windowStart = Date.now(); }
    if (checkOwnerHeader(req.headers.authorization, secret)) { next(); return; }
    if (++failures > 20) { res.status(429).send('Try again in one minute.'); return; }
    res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp owner", charset="UTF-8"');
    res.status(401).send('Owner sign-in required.');
  };
}
