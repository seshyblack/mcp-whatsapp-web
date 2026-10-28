import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface AuctionLot {
  productId: string;
  name: string;
  openingCents: number;
  imageUrl?: string;
  currency: 'MYR';
}

export interface AuctionMessage {
  chatId: string;
  stanzaId: string;
  body: string;
  type: string;
  productId?: string;
  quotedStanzaId?: string;
  quotedText?: string;
  receivedAt: number;
  fromMe: boolean;
}

export interface AuctionResponse {
  status: 'ignored' | 'selected' | 'pending_terms' | 'confirmed' | 'too_low' | 'needs_item' | 'closed' | 'terms_pending' | 'duplicate';
  reply?: string;
  productId?: string;
  amountCents?: number;
}

export interface AuctionDigestLot extends AuctionLot {
  highestCents: number | null;
  bidCount: number;
}

export type PrivateNoticeKind = 'leading' | 'outbid' | 'reminder_24h' | 'reminder_1h' | 'activity' | 'information';
export interface PrivateAuctionNotice {
  id: number;
  chatId: string;
  productId: string | null;
  kind: PrivateNoticeKind;
  text: string;
  eventKey: string;
  status: 'queued' | 'sending' | 'sent' | 'uncertain' | 'skipped';
  createdAt: number;
}

/** MYT (UTC+8) review boundaries align with UTC 00/10/30 minute marks. */
export function reviewIntervalMs(remainingMs: number): number {
  return remainingMs <= 60 * 60_000 ? 10 * 60_000 : 30 * 60_000;
}

export function latestReviewSlot(now: number, closeAt: number): number | null {
  if (now >= closeAt || now < 0) return null;
  const interval = reviewIntervalMs(closeAt - now);
  const slot = Math.floor(now / interval) * interval;
  // Only process a current boundary, never retrospectively flood after an outage/restart.
  return now - slot <= 90_000 ? slot : null;
}

export function formatMYR(cents: number): string {
  return 'RM ' + (cents / 100).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function parseBidCents(body: string): number | null {
  const amount = body.trim().match(/(?:\bRM\s*|\bMYR\s*|^\s*(?:my\s+|new\s+)?bid\s*(?:is\s*)?[:=]?\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  if (!amount) return null;
  const decimal = amount[1]!.replace(/,/g, '');
  const value = Number(decimal);
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) return null;
  return Math.round(value * 100);
}

export function productIdFromText(text: string): string | null {
  const match = text.match(/(?:https?:\/\/)?wa\.me\/p\/(\d{5,30})\/\d{6,15}/i);
  return match?.[1] ?? null;
}

/** Separate persistence from the WhatsApp session database; no network calls in a transaction. */
export class AuctionBook {
  private readonly db: Database.Database;
  constructor(file: string, private readonly termsUrl: string, private readonly closeAtMs: number) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS lots (product_id TEXT PRIMARY KEY, name TEXT NOT NULL, opening_cents INTEGER NOT NULL, currency TEXT NOT NULL, image_url TEXT, close_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS selections (chat_id TEXT NOT NULL, stanza_id TEXT NOT NULL, product_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(chat_id, stanza_id))',
      'CREATE TABLE IF NOT EXISTS bids (chat_id TEXT NOT NULL, stanza_id TEXT NOT NULL, product_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, seen_at INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY(chat_id, stanza_id))',
      'CREATE INDEX IF NOT EXISTS bids_lot_idx ON bids(product_id, status, amount_cents)',
      'CREATE TABLE IF NOT EXISTS agreements (chat_id TEXT PRIMARY KEY, accepted_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS channel_posts (slot TEXT PRIMARY KEY, status TEXT NOT NULL, receipt TEXT, recorded_at INTEGER NOT NULL)',
      // All private sends are durable and idempotent. Ambiguous failures are never retried automatically.
      'CREATE TABLE IF NOT EXISTS private_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, product_id TEXT, kind TEXT NOT NULL, event_key TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'queued\', created_at INTEGER NOT NULL, attempted_at INTEGER, receipt TEXT, UNIQUE(chat_id, kind, event_key))',
      'CREATE INDEX IF NOT EXISTS private_notices_pending_idx ON private_notices(status,created_at)',
      'CREATE TABLE IF NOT EXISTS auction_optouts (chat_id TEXT PRIMARY KEY, opted_out_at INTEGER NOT NULL)',
      // One review per item and slot; a bidder is notified only when their position changes.
      'CREATE TABLE IF NOT EXISTS auction_position_reviews (product_id TEXT PRIMARY KEY, last_slot INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS auction_bidder_positions (product_id TEXT NOT NULL, chat_id TEXT NOT NULL, last_position TEXT NOT NULL, last_slot INTEGER NOT NULL, PRIMARY KEY(product_id,chat_id))',
    ].join(';') + ';');
  }

  close(): void { this.db.close(); }

  upsertLots(lots: AuctionLot[]): number {
    const write = this.db.prepare('INSERT INTO lots (product_id,name,opening_cents,currency,image_url,close_at) VALUES (?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET name=excluded.name, image_url=excluded.image_url');
    return this.db.transaction(() => {
      for (const lot of lots) {
        if (!/^\d{5,30}$/.test(lot.productId) || !lot.name || !Number.isSafeInteger(lot.openingCents) || lot.openingCents <= 0 || lot.currency !== 'MYR') {
          throw new Error('Invalid MYR auction lot. Use Meta product ID, name and positive opening bid.');
        }
        write.run(lot.productId, lot.name, lot.openingCents, lot.currency, lot.imageUrl ?? null, this.closeAtMs);
      }
      return lots.length;
    })();
  }

  digest(): AuctionDigestLot[] {
    const rows = this.db.prepare(`SELECT l.product_id AS productId, l.name, l.opening_cents AS openingCents,
      l.image_url AS imageUrl, l.currency, MAX(b.amount_cents) AS highestCents,
      COUNT(b.stanza_id) AS bidCount
      FROM lots l LEFT JOIN bids b ON b.product_id = l.product_id AND b.status = 'confirmed'
      GROUP BY l.product_id ORDER BY bidCount DESC, l.name ASC`).all() as AuctionDigestLot[];
    return rows.map(row => ({ ...row, imageUrl: row.imageUrl || undefined }));
  }

  bidCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM bids WHERE status = 'confirmed'").get() as { n: number }).n;
  }

  /** Return the strongest known lot reference: quoted item, quoted bid, explicit product link,
   * or exactly one item shared in this chat in the last 15 minutes. Ambiguous messages never become bids. */
  private resolveLot(message: AuctionMessage): string | null {
    const explicit = message.productId ?? productIdFromText(message.body) ?? productIdFromText(message.quotedText ?? '');
    if (explicit && this.db.prepare('SELECT 1 FROM lots WHERE product_id=?').get(explicit)) return explicit;
    if (message.quotedStanzaId) {
      const quote = this.db.prepare(`SELECT product_id AS productId FROM bids WHERE chat_id=? AND stanza_id=?
        UNION ALL SELECT product_id AS productId FROM selections WHERE chat_id=? AND stanza_id=? LIMIT 1`)
        .get(message.chatId, message.quotedStanzaId, message.chatId, message.quotedStanzaId) as { productId: string } | undefined;
      if (quote) return quote.productId;
    }
    const recent = this.db.prepare('SELECT DISTINCT product_id AS productId FROM selections WHERE chat_id=? AND seen_at>=?')
      .all(message.chatId, message.receivedAt - 15 * 60_000) as { productId: string }[];
    return recent.length === 1 ? recent[0]!.productId : null;
  }

  private confirm(message: AuctionMessage, productId: string, amount: number): AuctionResponse {
    const lot = this.db.prepare('SELECT opening_cents AS openingCents, close_at AS closeAt FROM lots WHERE product_id=?')
      .get(productId) as { openingCents: number; closeAt: number } | undefined;
    if (!lot) return { status: 'needs_item' };
    if (message.receivedAt >= lot.closeAt) return { status: 'closed', productId, reply: 'Bidding for this lot has closed.' };
    const highest = (this.db.prepare("SELECT MAX(amount_cents) AS amount FROM bids WHERE product_id=? AND status='confirmed'")
      .get(productId) as { amount: number | null }).amount;
    const min = Math.max(lot.openingCents, (highest ?? 0) + 1);
    if (amount < min) {
      return { status: 'too_low', productId, reply: 'Thank you. The minimum eligible bid is ' + formatMYR(min) + '.' };
    }
    const write = this.db.prepare("UPDATE bids SET status='confirmed' WHERE chat_id=? AND stanza_id=?").run(message.chatId, message.stanzaId);
    if (!write.changes) {
      this.db.prepare("INSERT INTO bids (chat_id,stanza_id,product_id,amount_cents,seen_at,status) VALUES (?,?,?,?,?,'confirmed')")
        .run(message.chatId, message.stanzaId, productId, amount, message.receivedAt);
    }
    // Bids are final when confirmed, but position changes are announced only at scheduled reviews.
    // No last-minute automatic extension: the posted close time remains fixed.
    return { status: 'confirmed', productId, amountCents: amount, reply: 'Thank you. Your bid of ' + formatMYR(amount) + ' has been recorded.' };
  }

  /** Must be called only for live, incoming private-chat messages (not history or ordinary outbound texts). */
  handle(message: AuctionMessage): AuctionResponse {
    if (message.fromMe || !/^\d+@(s\.whatsapp\.net|lid)$/.test(message.chatId)) return { status: 'ignored' };
    if (/^(STOP|UNSUBSCRIBE|STOP AUCTION|STOP AUCTION UPDATES)[.!\s]*$/i.test(message.body.trim())) {
      this.db.transaction(() => {
        this.db.prepare('INSERT OR REPLACE INTO auction_optouts(chat_id,opted_out_at) VALUES(?,?)')
          .run(message.chatId, message.receivedAt);
        this.db.prepare("UPDATE private_notices SET status='skipped',receipt='Opted out' WHERE chat_id=? AND status='queued'")
          .run(message.chatId);
      })();
      return { status: 'ignored' };
    }
    // Rejoining requires a deliberate request; ordinary price messages never re-enable notifications.
    if (this.optedOut(message.chatId)) return { status: 'ignored' };
    return this.db.transaction((): AuctionResponse => {
      const productId = message.productId ?? productIdFromText(message.body);
      if (productId && this.db.prepare('SELECT 1 FROM lots WHERE product_id=?').get(productId)) {
        this.db.prepare('INSERT OR IGNORE INTO selections(chat_id,stanza_id,product_id,seen_at) VALUES(?,?,?,?)')
          .run(message.chatId, message.stanzaId, productId, message.receivedAt);
      }
      if (/^I AGREE[.!\s]*$/i.test(message.body.trim())) {
        const pending = this.db.prepare("SELECT chat_id AS chatId, stanza_id AS stanzaId, product_id AS productId, amount_cents AS amountCents, seen_at AS seenAt FROM bids WHERE chat_id=? AND status='pending_terms' ORDER BY seen_at ASC")
          .all(message.chatId) as Array<{ chatId: string; stanzaId: string; productId: string; amountCents: number; seenAt: number }>;
        if (!pending.length) return { status: 'ignored' };
        this.db.prepare('INSERT OR IGNORE INTO agreements(chat_id,accepted_at) VALUES(?,?)').run(message.chatId, message.receivedAt);
        const accepted: string[] = [];
        for (const bid of pending) {
          // A pending bid must not win by accepting after the lot closes.
          const result = this.confirm({ ...message, stanzaId: bid.stanzaId }, bid.productId, bid.amountCents);
          if (result.status === 'confirmed') accepted.push(formatMYR(bid.amountCents) + ' for ' + bid.productId);
          else this.db.prepare("UPDATE bids SET status='declined' WHERE chat_id=? AND stanza_id=?").run(message.chatId, bid.stanzaId);
        }
        return { status: 'confirmed', reply: accepted.length
          ? 'Thank you for accepting the auction terms. Confirmed bids: ' + accepted.join('; ') + '.'
          : 'Thank you. Your pending bid is no longer eligible; please place a fresh bid.' };
      }
      const amount = parseBidCents(message.body);
      if (amount == null) return productId ? { status: 'selected', productId } : { status: 'ignored' };
      if (this.db.prepare('SELECT 1 FROM bids WHERE chat_id=? AND stanza_id=?').get(message.chatId, message.stanzaId)) return { status: 'duplicate' };
      const lotId = this.resolveLot(message);
      // Do not mistake a price discussion in an unrelated Calmistry chat for an auction bid.
      if (!lotId) return { status: 'ignored' };
      if (!this.db.prepare('SELECT 1 FROM agreements WHERE chat_id=?').get(message.chatId)) {
        // This requires owner-configured terms; otherwise no customer-facing automated reply is safe.
        if (!this.termsUrl) return { status: 'terms_pending', productId: lotId };
        this.db.prepare("INSERT INTO bids(chat_id,stanza_id,product_id,amount_cents,seen_at,status) VALUES (?,?,?,?,?,'pending_terms')")
          .run(message.chatId, message.stanzaId, lotId, amount, message.receivedAt);
        return { status: 'pending_terms', productId: lotId, amountCents: amount,
          reply: 'Before I confirm your bid, please review our auction terms: ' + this.termsUrl + ' . Reply I AGREE if you accept them.' };
      }
      return this.confirm(message, lotId, amount);
    })();
  }

  private optedOut(chatId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM auction_optouts WHERE chat_id=?').get(chatId);
  }

  private enqueueNotice(chatId: string, productId: string | null, kind: PrivateNoticeKind, eventKey: string, text: string, now: number): void {
    if (this.optedOut(chatId)) return;
    this.db.prepare("INSERT OR IGNORE INTO private_notices(chat_id,product_id,kind,event_key,text,status,created_at) VALUES (?,?,?,?,?,'queued',?)")
      .run(chatId, productId, kind, eventKey, text, now);
  }

  /** Queue a transactional acknowledgement once, even if WhatsApp redelivers an event. */
  queueInformation(chatId: string, stanzaId: string, text: string, now = Date.now()): void {
    if (!/^\d+@(s\.whatsapp\.net|lid)$/.test(chatId) || !stanzaId || !text) return;
    this.enqueueNotice(chatId, null, 'information', stanzaId, text, now);
  }

  noticeCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM private_notices GROUP BY status')
      .all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map(row => [row.status, row.count]));
  }

  getLot(productId: string): AuctionDigestLot | undefined {
    return this.digest().find(lot => lot.productId === productId);
  }

  /**
   * Evaluate the actual leader at :00/:30, then :00/:10/.../:50 in the final hour.
   * Every accepted bidder receives a private card only when their position differs
   * from their last review. It is not live bidding; a single instant can contain
   * 50 or more bids without producing 50 rounds of position chatter.
   */
  reviewBidPositions(now = Date.now()): { reviewedLots: number; queued: number; intervals: number[] } {
    return this.db.transaction(() => {
      const lots = this.db.prepare('SELECT product_id AS productId,name,close_at AS closeAt FROM lots WHERE close_at>?')
        .all(now) as Array<{ productId: string; name: string; closeAt: number }>;
      let reviewedLots = 0;
      let queued = 0;
      const intervals: number[] = [];
      for (const lot of lots) {
        const slot = latestReviewSlot(now, lot.closeAt);
        if (slot === null) continue;
        const last = this.db.prepare('SELECT last_slot AS lastSlot FROM auction_position_reviews WHERE product_id=?')
          .get(lot.productId) as { lastSlot: number } | undefined;
        if (last && last.lastSlot >= slot) continue;
        const leader = this.db.prepare(`SELECT chat_id AS chatId FROM bids
          WHERE product_id=? AND status='confirmed' ORDER BY amount_cents DESC,seen_at ASC LIMIT 1`)
          .get(lot.productId) as { chatId: string } | undefined;
        const participants = this.db.prepare(`SELECT DISTINCT b.chat_id AS chatId FROM bids b
          JOIN agreements a ON a.chat_id=b.chat_id WHERE b.product_id=? AND b.status='confirmed'`)
          .all(lot.productId) as Array<{ chatId: string }>;
        for (const bidder of participants) {
          if (this.optedOut(bidder.chatId)) continue;
          const position: 'leading' | 'outbid' = leader?.chatId === bidder.chatId ? 'leading' : 'outbid';
          const lastPosition = this.db.prepare('SELECT last_position AS position FROM auction_bidder_positions WHERE product_id=? AND chat_id=?')
            .get(lot.productId, bidder.chatId) as { position: string } | undefined;
          if (lastPosition?.position !== position) {
            const text = position === 'leading'
              ? 'You are currently leading on ' + lot.name + '. Thank you for your confirmed bid.'
              : lot.name + ' has moved beyond your bid. You are welcome to place a revised bid before closing.';
            const eventKey = lot.productId + ':' + slot;
            this.enqueueNotice(bidder.chatId, lot.productId, position, eventKey, text, now);
            queued++;
          }
          this.db.prepare(`INSERT INTO auction_bidder_positions(product_id,chat_id,last_position,last_slot) VALUES (?,?,?,?)
            ON CONFLICT(product_id,chat_id) DO UPDATE SET last_position=excluded.last_position,last_slot=excluded.last_slot`)
            .run(lot.productId, bidder.chatId, position, slot);
        }
        this.db.prepare(`INSERT INTO auction_position_reviews(product_id,last_slot) VALUES (?,?)
          ON CONFLICT(product_id) DO UPDATE SET last_slot=excluded.last_slot`).run(lot.productId, slot);
        reviewedLots++;
        intervals.push(reviewIntervalMs(lot.closeAt - now) / 60_000);
      }
      return { reviewedLots, queued, intervals };
    })();
  }

  /** Read-only list for operator review; no sends occur. */
  listNotices(limit = 30): PrivateAuctionNotice[] {
    return this.db.prepare(`SELECT id,chat_id AS chatId,product_id AS productId,kind,event_key AS eventKey,text,status,created_at AS createdAt
      FROM private_notices ORDER BY id DESC LIMIT ?`).all(Math.min(100, Math.max(1, limit))) as PrivateAuctionNotice[];
  }

  /** Never resend an unacknowledged prior attempt; an operator must investigate it manually. */
  claimNextNotice(now = Date.now()): PrivateAuctionNotice | null {
    return this.db.transaction(() => {
      for (let iteration = 0; iteration < 100; iteration++) {
        const row = this.db.prepare(`SELECT id,chat_id AS chatId,product_id AS productId,kind,event_key AS eventKey,text,status,created_at AS createdAt
          FROM private_notices WHERE status='queued'
          ORDER BY CASE WHEN kind='information' THEN 0 ELSE 1 END, id ASC LIMIT 1`).get() as PrivateAuctionNotice | undefined;
        if (!row) return null;
        const lot = row.productId ? this.db.prepare('SELECT close_at AS closeAt FROM lots WHERE product_id=?')
          .get(row.productId) as { closeAt: number } | undefined : undefined;
        const expired = row.kind !== 'information' && !!lot && now >= lot.closeAt;
        const blocked = this.optedOut(row.chatId);
        const olderThanDay = now - row.createdAt > 24 * 60 * 60_000;
        const currentLeader = (row.kind === 'leading' || row.kind === 'outbid') && !!row.productId
          ? this.db.prepare("SELECT chat_id AS chatId FROM bids WHERE product_id=? AND status='confirmed' ORDER BY amount_cents DESC, seen_at ASC LIMIT 1")
              .get(row.productId) as { chatId: string } | undefined
          : undefined;
        const stalePosition = !!currentLeader && (
          (row.kind === 'leading' && currentLeader.chatId !== row.chatId) ||
          (row.kind === 'outbid' && currentLeader.chatId === row.chatId)
        );
        const superseded = ['leading', 'outbid'].includes(row.kind) && !!row.productId &&
          !!this.db.prepare(`SELECT 1 FROM private_notices WHERE chat_id=? AND product_id=? AND id>?
            AND kind IN ('leading','outbid') AND status IN ('queued','sending','sent') LIMIT 1`)
            .get(row.chatId, row.productId, row.id);
        if (expired || olderThanDay || stalePosition || blocked || superseded) {
          this.db.prepare("UPDATE private_notices SET status='skipped',receipt=? WHERE id=?")
            .run(blocked ? 'Opted out' : expired ? 'Lot closed' : stalePosition ? 'Position superseded' : superseded ? 'Later position review exists' : 'Expired in queue', row.id);
          continue;
        }
        this.db.prepare("UPDATE private_notices SET status='sending',attempted_at=? WHERE id=? AND status='queued'").run(now, row.id);
        return { ...row, status: 'sending' as const };
      }
      return null;
    })();
  }

  finishNotice(id: number, receipt: string): void {
    this.db.prepare("UPDATE private_notices SET status='sent',receipt=? WHERE id=? AND status='sending'")
      .run(receipt, id);
  }
  markNoticeUncertain(id: number, reason: string): void {
    this.db.prepare("UPDATE private_notices SET status='uncertain',receipt=? WHERE id=? AND status='sending'")
      .run(reason.slice(0,250), id);
  }

  /** Only accepted bidders in each relevant lot receive private closing reminders. */
  queueClosingReminders(now = Date.now()): number {
    let queued = 0;
    const lots = this.db.prepare('SELECT product_id AS productId,name,close_at AS closeAt FROM lots WHERE close_at>? AND close_at<=?')
      .all(now, now + 24 * 60 * 60_000) as { productId: string; name: string; closeAt: number }[];
    this.db.transaction(() => {
      for (const lot of lots) {
        const remaining = lot.closeAt - now;
        // Never deliver both reminders during the last hour.
        const kind: PrivateNoticeKind = remaining <= 60 * 60_000 ? 'reminder_1h' : 'reminder_24h';
        const stage = kind === 'reminder_1h' ? 'Final hour' : 'Closing tomorrow';
        const recipients = this.db.prepare(`SELECT DISTINCT b.chat_id AS chatId FROM bids b
          JOIN agreements a ON a.chat_id=b.chat_id
          WHERE b.product_id=? AND b.status='confirmed'`).all(lot.productId) as { chatId: string }[];
        for (const person of recipients) {
          if (this.optedOut(person.chatId)) continue;
          const eventKey = lot.productId + ':' + kind + ':' + lot.closeAt;
          const before = this.db.prepare('SELECT 1 FROM private_notices WHERE chat_id=? AND kind=? AND event_key=?')
            .get(person.chatId, kind, eventKey);
          if (before) continue;
          const text = stage + ': bidding for ' + lot.name + ' closes at ' +
            new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: true }).format(lot.closeAt) +
            ' MYT. You are welcome to revise your bid before then.';
          this.enqueueNotice(person.chatId, lot.productId, kind, eventKey, text, now);
          queued++;
        }
      }
    })();
    return queued;
  }

  /** Owner-triggered factual suspense update, limited to accepted bidders in the selected lot. */
  queuePrivateMomentum(productId: string, kind: 'active' | 'above_opening' | 'competitive', now = Date.now()): number {
    const lot = this.getLot(productId);
    if (!lot) throw new Error('Unknown auction lot.');
    const bidders = this.db.prepare(`SELECT DISTINCT b.chat_id AS chatId FROM bids b
      JOIN agreements a ON a.chat_id=b.chat_id
      WHERE b.product_id=? AND b.status='confirmed'`).all(productId) as { chatId: string }[];
    const competitiveCount = bidders.length;
    if (!bidders.length || (kind === 'above_opening' && (lot.highestCents ?? 0) <= lot.openingCents) ||
      (kind === 'competitive' && competitiveCount < 2)) throw new Error('Cannot send a suspense update that is not supported by actual bids.');
    const message = kind === 'active' ? 'This piece now has active bidding.'
      : kind === 'above_opening' ? 'Bidding for this piece has moved above the opening bid.'
        : 'This piece is becoming competitive.';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    let count = 0;
    this.db.transaction(() => {
      for (const person of bidders) {
        if (this.optedOut(person.chatId)) continue;
        const eventKey = productId + ':' + day + ':' + kind;
        const old = this.db.prepare('SELECT 1 FROM private_notices WHERE chat_id=? AND kind=? AND event_key=?')
          .get(person.chatId, 'activity', eventKey);
        if (old) continue;
        this.enqueueNotice(person.chatId, productId, 'activity', eventKey, lot.name + ': ' + message, now);
        count++;
      }
    })();
    return count;
  }

  /** End-of-auction is owner reviewed: do not automatically announce a winner or collect payment. */
  closingReview(now = Date.now()): Array<{ productId: string; name: string; closeAt: number; highestCents: number | null; leaderChatId: string | null; bidCount: number }> {
    const rows = this.db.prepare(`SELECT l.product_id AS productId,l.name,l.close_at AS closeAt,
      (SELECT MAX(b.amount_cents) FROM bids b WHERE b.product_id=l.product_id AND b.status='confirmed') AS highestCents,
      (SELECT b.chat_id FROM bids b WHERE b.product_id=l.product_id AND b.status='confirmed' ORDER BY b.amount_cents DESC, b.seen_at ASC LIMIT 1) AS leaderChatId,
      (SELECT COUNT(*) FROM bids b WHERE b.product_id=l.product_id AND b.status='confirmed') AS bidCount
      FROM lots l WHERE l.close_at<=? ORDER BY l.name`).all(now);
    return rows as Array<{ productId: string; name: string; closeAt: number; highestCents: number | null; leaderChatId: string | null; bidCount: number }>;
  }

  /** Claims a post slot before sending; uncertain sends are NOT retried automatically. */
  claimPost(slot: string, now = Date.now()): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO channel_posts(slot,status,recorded_at) VALUES (?,'sending',?)").run(slot, now).changes === 1;
  }
  completePost(slot: string, receipt: string): void {
    this.db.prepare("UPDATE channel_posts SET status='sent',receipt=? WHERE slot=? AND status='sending'").run(receipt, slot);
  }
  uncertainPost(slot: string, details: string): void {
    this.db.prepare("UPDATE channel_posts SET status='uncertain',receipt=? WHERE slot=? AND status='sending'").run(details.slice(0,300), slot);
  }
  postStatus(slot: string): string | null {
    return (this.db.prepare('SELECT status FROM channel_posts WHERE slot=?').get(slot) as { status: string } | undefined)?.status ?? null;
  }
}
