import type Database from 'better-sqlite3';
import { randomInt } from 'node:crypto';
import type { WhatsAppBackend } from './backend.js';
import { log } from '../utils/logger.js';

type NoticeKind = 'confirmation' | 'outbid';
const AUCTION_CLOSE_AT = Date.parse('2026-11-22T21:00:00+08:00');
type Verdict = 'accepted' | 'too_low';
interface Leader { chatId: string; amount: number; }
interface Notice { id: number; chatId: string; text: string; }

export function bidderLabel(id: number): string {
  return String(id).padStart(3, '0');
}

function sgd(amount: number): string {
  return 'S$' + amount.toLocaleString('en-SG');
}

/**
 * This register is stored inside the existing persistent Render auction SQLite
 * database. A bidder's identity is their verified incoming WhatsApp chat JID,
 * never the editable phone-number field in a website form.
 *
 * Outbound is a separate, opt-in switch. Drafts created while outbound is off
 * are NEVER promoted to pending automatically, even if outbound is later enabled.
 */
export class AuctionBidderRegistry {
  private delivering = false;
  private stopped = false;

  constructor(
    private readonly db: Database.Database,
    private readonly whatsapp: WhatsAppBackend,
    private readonly outboundEnabled: boolean,
  ) {
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS auction_bidders (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL UNIQUE, first_bid_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS auction_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, chat_id TEXT NOT NULL, source_message_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, sent_message_id TEXT, error TEXT, UNIQUE(kind, chat_id, source_message_id))',
      'CREATE INDEX IF NOT EXISTS auction_notices_state ON auction_notices(state, id)',
    ].join(';') + ';');
    const columns = this.db.pragma('table_info(auction_bidders)') as Array<{name:string}>;
    if (!columns.some(c => c.name === 'public_number')) {
      this.db.exec('ALTER TABLE auction_bidders ADD COLUMN public_number INTEGER');
    }
    if (!columns.some(c => c.name === 'display_name')) {
      this.db.exec('ALTER TABLE auction_bidders ADD COLUMN display_name TEXT');
    }
    // Keep internal autoincrement IDs; public numbers are a persistent random permutation.
    // Existing rows are migrated once; no public number is ever reused.
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM auction_bidders WHERE public_number IS NULL ORDER BY id').all() as Array<{id:number}>;
      for (const row of existing) {
        this.db.prepare('UPDATE auction_bidders SET public_number=? WHERE id=?').run(this.pickNumber(), row.id);
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS auction_bidder_public_number ON auction_bidders(public_number)');
    })();
  }

  private pickNumber(): number {
    const taken = new Set((this.db.prepare('SELECT public_number FROM auction_bidders WHERE public_number IS NOT NULL').all() as Array<{public_number:number}>).map(x => x.public_number));
    const available = Array.from({length:100},(_,i)=>800+i).filter(x=>!taken.has(x));
    if (!available.length) throw new Error('All 100 confidential bidder numbers are allocated; manual intervention required');
    return available[randomInt(available.length)]!;
  }

  private number(chatId: string, at: number, name?: string): string {
    const query = this.db.prepare('SELECT public_number AS number FROM auction_bidders WHERE chat_id=?');
    const existing = query.get(chatId) as {number:number}|undefined;
    const cleanName = name?.replace(/[\r\n]/g,' ').trim().slice(0,100) || null;
    if (existing) {
      if (cleanName) this.db.prepare('UPDATE auction_bidders SET display_name=COALESCE(display_name,?) WHERE chat_id=?').run(cleanName,chatId);
      return bidderLabel(existing.number);
    }
    const number = this.pickNumber();
    this.db.prepare('INSERT INTO auction_bidders(chat_id,first_bid_at,public_number,display_name) VALUES (?,?,?,?)').run(chatId, at, number, cleanName);
    return bidderLabel(number);
  }

  /**
   * Called only for validated, live, registered bids after database insert.
   * All writes should occur in the caller's SQLite transaction.
   * Previously leading bidder receives a separate private outbid notification.
   */
  registerBid(input: {
    messageId: string; chatId: string; lot: string; amount: number;
    at: number; verdict: Verdict; previous?: Leader; name?: string;
  }): string {
    const { messageId, chatId, lot, amount, at, verdict, previous, name } = input;
    const number = this.number(chatId, at, name);
    const previousNumber = previous ? this.number(previous.chatId, at) : undefined;
    const leading = verdict === 'accepted';
    const text = [
      'CALMISTRY — PRIVATE COLLECTION',
      '',
      leading
        ? '*You are currently the highest bidder for Lot ' + lot + '.*'
        : '*You are not currently the highest bidder for Lot ' + lot + '.*',
      '',
      'Your offer of ' + sgd(amount) + ' has been recorded.',
      'Your bidder number · ' + number,
      '',
      leading
        ? 'We will notify you privately if you are outbid.'
        : 'You are welcome to submit a further offer in the same WhatsApp chat.',
      'The winning bid is confirmed after the auction closes.',
    ].join('\n');
    this.queue('confirmation', chatId, messageId, text, at);

    if (leading && previous && previous.chatId !== chatId && previousNumber) {
      const outbidText = [
        'CALMISTRY — PRIVATE COLLECTION',
        '',
        '*You have been outbid on Lot ' + lot + '.*',
        '',
        'Your bidder number · ' + previousNumber,
        '',
        'If you wish to place a further offer, you may do so in this WhatsApp chat.',
      ].join('\n');
      this.queue('outbid', previous.chatId, messageId, outbidText, at);
    }
    return number;
  }

  private queue(kind: NoticeKind, chatId: string, sourceMessageId: string, text: string, at: number): void {
    // Never send stale historical messages or anything queued in preview.
    const fresh = at <= Date.now() + 60_000 && Date.now() - at <= 15 * 60_000;
    const state = this.outboundEnabled && fresh && Date.now() < AUCTION_CLOSE_AT ? 'pending' : 'draft';
    this.db.prepare('INSERT OR IGNORE INTO auction_notices(kind,chat_id,source_message_id,text,state,created_at) VALUES (?,?,?,?,?,?)')
      .run(kind, chatId, sourceMessageId, text, state, Date.now());
  }

  /**
   * Conservative at-most-once sending: mark "sending" before network I/O;
   * if network reports a failure, retain as uncertain instead of retrying and
   * risking duplicate WhatsApp messages.
   */
  async flush(): Promise<void> {
    if (Date.now() >= AUCTION_CLOSE_AT) {
      this.db.prepare("UPDATE auction_notices SET state='expired' WHERE state='pending'").run();
      return;
    }
    if (this.delivering || this.stopped || !this.outboundEnabled ||
      !this.whatsapp.isAuthenticated()) return;
    this.delivering = true;
    try {
      for (let i=0; i<12 && !this.stopped; i++) {
        const claim = this.db.transaction(() => {
          const row = this.db.prepare("SELECT id, chat_id AS chatId, text FROM auction_notices WHERE state='pending' ORDER BY id LIMIT 1").get() as Notice | undefined;
          if (!row) return undefined;
          this.db.prepare("UPDATE auction_notices SET state='sending' WHERE id=? AND state='pending'").run(row.id);
          return row;
        })();
        if (!claim) break;
        try {
          if (Date.now() >= AUCTION_CLOSE_AT) {
            this.db.prepare("UPDATE auction_notices SET state='expired' WHERE id=? AND state='sending'").run(claim.id);
            break;
          }
          const sent = await this.whatsapp.sendMessage(claim.chatId, claim.text);
          this.db.prepare("UPDATE auction_notices SET state='sent',sent_message_id=? WHERE id=? AND state='sending'")
            .run(sent.id,claim.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.db.prepare("UPDATE auction_notices SET state='uncertain',error=? WHERE id=? AND state='sending'")
            .run(reason.slice(0,400),claim.id);
          log.error('Auction private acknowledgement delivery uncertain; no automatic retry', error);
        }
        // Rate-limit sequential personal notices.
        if (i < 11 && !this.stopped) await new Promise(resolve=>setTimeout(resolve, 2500));
      }
    } finally {
      this.delivering = false;
    }
  }

  stop(): void { this.stopped = true; }

  status() {
    const count = (sql:string) => (this.db.prepare(sql).get() as {n:number}).n;
    return {
      registeredBidders:count('SELECT COUNT(*) AS n FROM auction_bidders'),
      noticeBreakdown:this.db.prepare('SELECT state,kind,COUNT(*) AS count FROM auction_notices GROUP BY state,kind ORDER BY state,kind').all(),
      messagesSent:count("SELECT COUNT(*) AS n FROM auction_notices WHERE state='sent'"),
      outboundEnabled:this.outboundEnabled,
      note:'All notices are private to participating bidders. Drafts are not auto-sent. Uncertain sends require owner review.',
    };
  }
}
