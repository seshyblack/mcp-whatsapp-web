import type Database from 'better-sqlite3';
import { log } from '../utils/logger.js';

/**
 * One-time, owner-authorized removal of the three known 8 November opening
 * test submissions from Clairie's chat on Lot 01 (S$410, S$420, S$500).
 *
 * This intentionally does not delete WhatsApp messages, and it preserves
 * unrelated bidders or bids. Tombstones prevent the recurring WhatsApp
 * history sweep from putting the removed test bids back in the live register.
 */
const CLEANUP_KEY = 'opening_test_bids_removed_20261108_v1';
const TEST_CHAT = '6588747000@s.whatsapp.net';
const WINDOW_START = Date.parse('2026-11-08T02:40:00.000Z');
const WINDOW_END = Date.parse('2026-11-08T02:46:00.000Z');
const TEST_AMOUNTS = [410, 420, 500] as const;

export function isDeletedAuctionTestMessage(db: Database.Database, messageId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM ignored_auction_test_messages WHERE message_id=?').get(messageId));
}

export function removeKnownOpeningTestBids(db: Database.Database): number {
  db.exec([
    'CREATE TABLE IF NOT EXISTS ignored_auction_test_messages (message_id TEXT PRIMARY KEY, ignored_at INTEGER NOT NULL)',
  ].join(';') + ';');

  if (db.prepare('SELECT 1 FROM monitor_state WHERE key=?').get(CLEANUP_KEY)) return 0;

  const matches = db.prepare([
    'SELECT message_id AS messageId, amount',
    'FROM monitored_bids',
    "WHERE mode='live' AND chat_id=? AND lot='01'",
    'AND amount IN (410,420,500) AND received_at BETWEEN ? AND ?',
    'ORDER BY amount',
  ].join(' ')).all(TEST_CHAT, WINDOW_START, WINDOW_END) as Array<{messageId: string; amount: number}>;

  // Never delete a partial or unexpectedly larger set without investigation.
  if (matches.length !== 3 ||
      matches.some((row,i) => row.amount !== TEST_AMOUNTS[i])) {
    log.warn('Calmistry one-time test cleanup NOT executed: expected exactly 3 matching test bids, found ' + matches.length);
    return 0;
  }

  const result = db.transaction(() => {
    for (const bid of matches) {
      db.prepare('INSERT OR IGNORE INTO ignored_auction_test_messages(message_id,ignored_at) VALUES (?,?)')
        .run(bid.messageId, Date.now());
      db.prepare('DELETE FROM auction_notices WHERE source_message_id=?').run(bid.messageId);
      db.prepare('DELETE FROM outbid_drafts WHERE replaced_by=?').run(bid.messageId);
      db.prepare('DELETE FROM monitored_bids WHERE message_id=?').run(bid.messageId);
    }

    // Only drop this test participant's 8xx bidder number if this WhatsApp
    // identity has no remaining bids in the live auction.
    const stillUsed = db.prepare("SELECT 1 FROM monitored_bids WHERE chat_id=? AND mode='live' LIMIT 1")
      .get(TEST_CHAT);
    if (!stillUsed) db.prepare('DELETE FROM auction_bidders WHERE chat_id=?').run(TEST_CHAT);

    // The separate pre-opening sandbox is no longer active after auction start.
    // Clear ALL preview-only test records too; these never count as real bids.
    db.prepare('DELETE FROM auction_test_notices').run();
    db.prepare('DELETE FROM auction_test_bids').run();
    db.prepare('DELETE FROM auction_test_bidders').run();

    db.prepare('INSERT INTO monitor_state(key,value) VALUES (?,?)').run(CLEANUP_KEY, 'removed_3_and_preview_sandbox');
    return matches.length;
  })();

  log.info('Calmistry opening test submissions removed from live auction register: ' + result);
  return result;
}
