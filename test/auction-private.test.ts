import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuctionBook } from '../src/services/auction.js';
import { renderPrivateBidCard } from '../src/services/auction-private-card.js';

const folders: string[] = [];
const close = 1_900_000_000_000;
const a = '60111222222@s.whatsapp.net';
const b = '60133334444@s.whatsapp.net';
const productId = '28881984484829546';
const t = close - 2 * 60 * 60_000;
function message(chatId: string, stanzaId: string, body: string, receivedAt = t) {
  return { chatId, stanzaId, body, type: 'chat', receivedAt, fromMe: false };
}
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'calmistry-private-auction-'));
  folders.push(directory);
  const book = new AuctionBook(path.join(directory, 'private.sqlite'), 'https://example.com/terms', close);
  book.upsertLots([{ productId, name: 'Alera Divider', openingCents: 10000, currency: 'MYR' }]);
  return book;
}
function acceptedBid(book: AuctionBook, chatId: string, marker: string, bid: number) {
  book.handle({ ...message(chatId, marker + '-share', 'https://wa.me/p/' + productId + '/6588741000'), type: 'chat' });
  expect(book.handle(message(chatId, marker + '-bid', 'My bid is RM ' + bid)).status).toBe('pending_terms');
  expect(book.handle(message(chatId, marker + '-agree', 'I AGREE', t + 1000)).status).toBe('confirmed');
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('private bidder notification ledger', () => {
  it('sends bid-card notices only to the new leader and previous leader; no Channel posts', () => {
    const book = fixture();
    acceptedBid(book, a, 'a', 150);
    acceptedBid(book, b, 'b', 200);
    const rows = book.listNotices(20);
    expect(rows.map(row => ({ recipient: row.chatId, kind: row.kind }))).toEqual([
      { recipient: a, kind: 'outbid' },
      { recipient: b, kind: 'leading' },
      { recipient: a, kind: 'leading' },
    ]);
    expect(rows[0]!.text).not.toContain('RM 200');
    expect(book.claimNextNotice(t + 2000)).toMatchObject({ chatId: b, kind: 'leading' });
    expect(book.noticeCounts().skipped).toBe(1); // Superseded leading message never goes out.
    const outbid = book.claimNextNotice(t + 2000);
    expect(outbid).toMatchObject({ chatId: a, kind: 'outbid' });
    book.finishNotice(outbid!.id, 'receipt-01');
    expect(book.noticeCounts().sent).toBe(1);
    expect(book.claimNextNotice(t + 2000)).toBeNull();
    book.close();
  });

  it('deduplicates acknowledgements and does not retry a send with uncertain delivery', () => {
    const book = fixture();
    book.queueInformation(a, 'original', 'Auction terms', t);
    book.queueInformation(a, 'original', 'Auction terms', t);
    expect(book.listNotices()).toHaveLength(1);
    const claimed = book.claimNextNotice(t + 1000);
    expect(claimed).toMatchObject({ chatId: a, kind: 'information' });
    book.markNoticeUncertain(claimed!.id, 'WhatsApp response ambiguous');
    expect(book.claimNextNotice(t + 1200)).toBeNull();
    expect(book.noticeCounts().uncertain).toBe(1);
    book.close();
  });

  it('can queue one private update for multiple accepted bidders without using strangers', () => {
    const book = fixture();
    acceptedBid(book, a, 'a', 150);
    acceptedBid(book, b, 'b', 200);
    expect(book.queuePrivateMomentum(productId, 'competitive', t + 3000)).toBe(2);
    expect(book.queuePrivateMomentum(productId, 'competitive', t + 3000)).toBe(0);
    const activity = book.listNotices(20).filter(n => n.kind === 'activity');
    expect(new Set(activity.map(n => n.chatId))).toEqual(new Set([a, b]));
    expect(activity.every(n => !n.chatId.endsWith('@newsletter'))).toBe(true);
    book.close();
  });

  it('queues once-per-stage private closing notices for everyone who bid and accepted terms', () => {
    const book = fixture();
    acceptedBid(book, a, 'a', 150);
    acceptedBid(book, b, 'b', 200);
    expect(book.queueClosingReminders(close - 23 * 60 * 60_000)).toBe(2);
    expect(book.queueClosingReminders(close - 23 * 60 * 60_000)).toBe(0);
    expect(book.queueClosingReminders(close - 40 * 60_000)).toBe(2);
    expect(book.queueClosingReminders(close - 40 * 60_000)).toBe(0);
    const reminders = book.listNotices(30).filter(n => n.kind.startsWith('reminder_'));
    expect(reminders).toHaveLength(4);
    expect(new Set(reminders.map(n => n.chatId))).toEqual(new Set([a, b]));
    expect(book.closingReview(close)).toMatchObject([{ productId, highestCents: 20000, leaderChatId: b }]);
    book.close();
  });

  it('never treats an unrelated WhatsApp price conversation as an auction bid', () => {
    const book = fixture();
    const result = book.handle(message(a, 'ordinary-chat', 'It is RM 450. Is that alright?'));
    expect(result.status).toBe('ignored');
    expect(book.bidCount()).toBe(0);
    expect(book.listNotices()).toHaveLength(0);
    book.close();
  });
});

describe('branded private auction card', () => {
  it('renders a JPEG for one lot without another bidder identity or bid', async () => {
    const book = fixture();
    const card = await renderPrivateBidCard(book.digest()[0]!, 'outbid');
    expect(card[0]).toBe(0xff);
    expect(card[1]).toBe(0xd8);
    expect(card.length).toBeGreaterThan(5000);
    book.close();
  });
});
