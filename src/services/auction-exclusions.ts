import type Database from 'better-sqlite3';
import { log } from '../utils/logger.js';

/** Verified WhatsApp identities for the owner's explicitly excluded test participant.
 * Match the authenticated sender chat, NEVER the editable name or phone in a bid form.
 */
const EXCLUDED_CHAT_IDS = ['6588747000@s.whatsapp.net', '106154445287506@lid'] as const;

export function isExcludedAuctionSender(chatId: string | undefined | null): boolean {
  return !!chatId && (EXCLUDED_CHAT_IDS as readonly string[]).includes(chatId);
}

type ExclusionResult = {
  removedBids: number;
  removedLots: string[];
  lot01ActiveBids: number;
  lot01LeadingBid: number | null;
  lot01OpeningBid: number;
  excludedChatIds: number;
};

/** Remove all bids from the confirmed test WhatsApp account, not only the
 * three known first messages. Tombstone removed message IDs and retain all
 * unrelated bids. Recompute a valid remaining leader if necessary.
 *
 * Idempotent and safe to run at server startup while the DB is locked by SQLite.
 * Deliberately does not delete WhatsApp chat messages already delivered.
 */
export function resetAuctionExcludingClairie(
  db: Database.Database,
  lot01OpeningBid: number,
): ExclusionResult {
  db.exec('CREATE TABLE IF NOT EXISTS ignored_auction_test_messages (message_id TEXT PRIMARY KEY, ignored_at INTEGER NOT NULL)');
  const placeholders = EXCLUDED_CHAT_IDS.map(() => '?').join(',');
  const result = db.transaction((): ExclusionResult => {
    const bids = db.prepare(
      'SELECT message_id AS id,lot FROM monitored_bids WHERE chat_id IN (' + placeholders + ')',
    ).all(...EXCLUDED_CHAT_IDS) as Array<{ id: string; lot: string }>;

    const lots = Array.from(new Set(bids.map(b => b.lot))).sort();
    const tombstone = db.prepare(
      'INSERT OR IGNORE INTO ignored_auction_test_messages(message_id,ignored_at) VALUES (?,?)',
    );
    const removeNotice = db.prepare('DELETE FROM auction_notices WHERE source_message_id=?');
    const removeDraft = db.prepare('DELETE FROM outbid_drafts WHERE replaced_by=?');
    for (const bid of bids) {
      tombstone.run(bid.id, Date.now());
      removeNotice.run(bid.id);
      removeDraft.run(bid.id);
    }
    db.prepare('DELETE FROM auction_notices WHERE chat_id IN (' + placeholders + ')').run(...EXCLUDED_CHAT_IDS);
    db.prepare('DELETE FROM outbid_drafts WHERE chat_id IN (' + placeholders + ')').run(...EXCLUDED_CHAT_IDS);
    db.prepare('DELETE FROM monitored_bids WHERE chat_id IN (' + placeholders + ')').run(...EXCLUDED_CHAT_IDS);
    db.prepare('DELETE FROM auction_bidders WHERE chat_id IN (' + placeholders + ')').run(...EXCLUDED_CHAT_IDS);

    // Genuine bids marked "not leading" because of the test bidder must be
    // correctly ranked after that bidder is excluded.
    for (const lot of lots) {
      const top = db.prepare(
        "SELECT message_id AS id, verdict FROM monitored_bids WHERE lot=? AND mode='live' AND verdict IN ('accepted','registered_not_leading') ORDER BY amount DESC,received_at ASC LIMIT 1",
      ).get(lot) as { id: string; verdict: string } | undefined;
      if (top?.verdict === 'registered_not_leading') {
        db.prepare("UPDATE monitored_bids SET verdict='accepted' WHERE message_id=?").run(top.id);
      }
    }

    const summary = db.prepare(
      "SELECT COUNT(*) AS count, MAX(amount) AS leading FROM monitored_bids WHERE lot='01' AND mode='live' AND verdict IN ('accepted','registered_not_leading')",
    ).get() as { count: number; leading: number | null };

    const info: ExclusionResult = {
      removedBids: bids.length,
      removedLots: lots,
      lot01ActiveBids: summary.count,
      lot01LeadingBid: summary.leading,
      lot01OpeningBid,
      excludedChatIds: EXCLUDED_CHAT_IDS.length,
    };
    db.prepare(
      "INSERT INTO monitor_state(key,value) VALUES ('clairie_test_account_excluded_20261108',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(JSON.stringify(info));
    return info;
  })();

  // Warn level appears in Render's STDERR application logs, unlike INFO.
  // No names, phone numbers, or private bids from other bidders are logged.
  log.warn('Calmistry owner-requested Alera reset: ' + JSON.stringify(result));
  return result;
}
