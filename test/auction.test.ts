import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuctionBook, parseBidCents, productIdFromText } from '../src/services/auction.js';
import { renderAuctionDigest } from '../src/services/auction-poster.js';

const dirs: string[] = [];
const chatId = '60123456789@s.whatsapp.net';
const closeAt = 1_900_000_000_000;
function book(terms = 'https://example.com/auction-terms') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'calmistry-auction-'));
  dirs.push(dir);
  const b = new AuctionBook(path.join(dir, 'auction.sqlite'), terms, closeAt);
  b.upsertLots([{ productId: '28881984484829546', name: 'Alera Divider', openingCents: 10000, currency: 'MYR' }]);
  return b;
}
function message(stanzaId: string, body: string, extra: Record<string, unknown> = {}) {
  return { chatId, stanzaId, body, type: 'chat', fromMe: false, receivedAt: closeAt - 1000 * 60 * 60, ...extra };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Calmistry auction parsing', () => {
  it('recognises MYR bid amounts without confusing unrelated conversation', () => {
    expect(parseBidCents('My bid is RM180')).toBe(18000);
    expect(parseBidCents('RM 2,250.50')).toBe(225050);
    expect(parseBidCents('new bid: 390')).toBe(39000);
    expect(parseBidCents('See you next Thursday at 6')).toBeNull();
    expect(productIdFromText('Follow this link to view our item: https://wa.me/p/28881984484829546/6588741000'))
      .toBe('28881984484829546');
  });
  it('keeps pending bids out of highest bid until terms acceptance, and supports reply-based rebids', () => {
    const b = book();
    expect(b.handle(message('share', 'https://wa.me/p/28881984484829546/6588741000')).status).toBe('selected');
    const first = b.handle(message('bid180', 'My bid is RM180'));
    expect(first.status).toBe('pending_terms');
    expect(first.reply).toContain('I AGREE');
    expect(b.digest()[0].highestCents).toBeNull();
    expect(b.handle(message('accept', 'I AGREE')).status).toBe('confirmed');
    expect(b.digest()[0].highestCents).toBe(18000);
    expect(b.handle(message('rebid', 'RM 200', { quotedStanzaId: 'bid180' })).status).toBe('confirmed');
    expect(b.digest()[0]).toMatchObject({ highestCents: 20000, bidCount: 2 });
    expect(b.handle(message('rebid', 'RM 200', { quotedStanzaId: 'bid180' })).status).toBe('duplicate');
    expect(b.handle(message('low', 'RM 150', { quotedStanzaId: 'bid180' })).status).toBe('too_low');
    expect(b.bidCount()).toBe(2);
    b.close();
  });
  it('rejects uncertain lot identity and ignores outgoing messages', () => {
    const b = book();
    expect(b.handle(message('out', 'RM 300', { fromMe: true })).status).toBe('ignored');
    expect(b.handle(message('unknown', 'RM 300')).status).toBe('needs_item');
    expect(b.handle(message('native', '', { productId: '28881984484829546', type: 'product' })).status).toBe('selected');
    expect(b.handle(message('bid', 'RM 300', { quotedStanzaId: 'native' })).status).toBe('pending_terms');
    b.close();
  });
  it('preserves original opening bids and protects one-shot public post slots', () => {
    const b = book();
    b.upsertLots([{ productId: '28881984484829546', name: 'Alera Divider (edited)', openingCents: 99999, currency: 'MYR' }]);
    expect(b.digest()[0].openingCents).toBe(10000);
    expect(b.claimPost('2026-11-23T04')).toBe(true);
    expect(b.claimPost('2026-11-23T04')).toBe(false);
    b.uncertainPost('2026-11-23T04', 'Channel upload uncertain');
    expect(b.postStatus('2026-11-23T04')).toBe('uncertain');
    b.close();
  });
  it('extends a lot by three minutes when a valid bid arrives during final three minutes', () => {
    const b = book();
    b.handle(message('item', '', { productId: '28881984484829546', type: 'product', receivedAt: closeAt - 200_000 }));
    b.handle(message('opening', 'RM 100', { receivedAt: closeAt - 200_000 }));
    b.handle(message('consent', 'I AGREE', { receivedAt: closeAt - 180_001 }));
    expect(b.handle(message('last', 'RM 200', { quotedStanzaId: 'opening', receivedAt: closeAt - 80_000 })).status)
      .toBe('confirmed');
    expect(b.handle(message('extension', 'RM 230', { quotedStanzaId: 'last', receivedAt: closeAt + 75_000 })).status)
      .toBe('confirmed');
    b.close();
  });
});

describe('Calmistry hourly graphic', () => {
  it('renders a real JPEG without requiring external product photos', async () => {
    const b = book();
    const jpeg = await renderAuctionDigest(b.digest(), new Date('2026-11-12T08:00:00Z'));
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(jpeg.length).toBeGreaterThan(5000);
    b.close();
  });
});
