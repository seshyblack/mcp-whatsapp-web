import type Database from 'better-sqlite3';
import type { SimpleMessage, WhatsAppBackend } from './backend.js';
import { validAuctionBidAmount } from './auction-pricing.js';
import { log } from '../utils/logger.js';

export const TEST_BID_HEADER = 'CALMISTRY AUCTION — TEST MESSAGE (NOT A BID)';
const REAL_BID_HEADER = 'CALMISTRY — PRIVATE COLLECTION AUCTION';
const REAL_HEADER_PATTERN = /^CALMISTRY\s*[—-]\s*PRIVATE COLLECTION AUCTION\s*$/mi;
const TEST_EXPIRES_AT = Date.parse('2026-11-08T10:00:00+08:00');
const FRESH_FOR_MS = 15 * 60_000;

type Parsed = { lot: string; amount: number; consent: boolean };
type ParsedFn = (message: string) => Parsed | null;
type Pending = { id: number; chatId: string; text: string };

const price = (n: number) => 'S$' + n.toLocaleString('en-SG');
const num = (n: number) => 'B' + String(n).padStart(3, '0');

/**
 * Completely separate from auction_bidders / monitored_bids / auction_notices.
 * An explicit pre-opening TEST header is mandatory to prevent a test from
 * entering the live bid register. No notifications are sent unless the owner
 * independently enables AUCTION_TEST_REPLIES_ENABLED on a preview monitor.
 */
export class AuctionTestSandbox {
  private sending = false;
  private stopped = false;
  constructor(
    private readonly db: Database.Database,
    private readonly whatsapp: WhatsAppBackend,
    private readonly enabled: boolean,
  ) {
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS auction_test_bidders (id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL UNIQUE)',
      'CREATE TABLE IF NOT EXISTS auction_test_bids (message_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,lot TEXT NOT NULL,amount INTEGER NOT NULL,received_at_ms INTEGER NOT NULL,verdict TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS auction_test_lot ON auction_test_bids(lot,verdict,amount)',
      "CREATE TABLE IF NOT EXISTS auction_test_notices (id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,source_message_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,created_at_ms INTEGER NOT NULL,sent_message_id TEXT,error TEXT,UNIQUE(source_message_id,chat_id,kind))",
    ].join(';') + ';');
  }

  private bidderNumber(chatId: string): string {
    const stmt = this.db.prepare('SELECT id FROM auction_test_bidders WHERE chat_id=?');
    const old = stmt.get(chatId) as {id:number}|undefined;
    if (old) return num(old.id);
    this.db.prepare('INSERT INTO auction_test_bidders(chat_id) VALUES (?)').run(chatId);
    const row = stmt.get(chatId) as {id:number};
    return num(row.id);
  }

  private addNotice(kind: 'confirmation'|'outbid', chatId: string,
    messageId: string, text: string, receivedAt: number) {
    // Never replay an old test as a newly sent WhatsApp message.
    const fresh = receivedAt <= Date.now()+60_000 && Date.now()-receivedAt<=FRESH_FOR_MS;
    const state = fresh && this.enabled && Date.now()<TEST_EXPIRES_AT ? 'pending' : 'draft';
    this.db.prepare('INSERT OR IGNORE INTO auction_test_notices (chat_id,source_message_id,kind,text,state,created_at_ms) VALUES (?,?,?,?,?,?)')
      .run(chatId,messageId,kind,text,state,Date.now());
  }

  /**
   * Only messages that deliberately start with the exact TEST header qualify.
   * Use the same strict live parser for consent and fields after swapping the
   * header, but never insert a test bid into the live auction tables.
   */
  record(message: SimpleMessage, parseLive: ParsedFn,
    openings: Readonly<Record<string,number>>): boolean {
    if (!this.enabled || this.stopped || Date.now()>=TEST_EXPIRES_AT) return false;
    if (message.fromMe || message.type!=='chat' || !message.id ||
        !/^\d+@(s\.whatsapp\.net|lid)$/.test(message.chatId||'') ||
        !Number.isFinite(message.timestamp)) return false;
    const lines=message.body.split(/\r?\n/);
    if (lines[0]!==TEST_BID_HEADER || REAL_HEADER_PATTERN.test(message.body)) return false;
    if(this.db.prepare('SELECT 1 FROM auction_test_bids WHERE message_id=?').get(message.id)) return false;

    const parsed=parseLive([REAL_BID_HEADER,...lines.slice(1)].join('\n'));
    if (!parsed || !parsed.consent) return false;
    const opening=openings[parsed.lot];
    if(!validAuctionBidAmount(opening,parsed.amount)) return false;
    const chatId=message.chatId!;
    const at=message.timestamp*1000;

    this.db.transaction(()=>{
      const existing=this.db.prepare("SELECT MAX(amount) AS amount FROM auction_test_bids WHERE chat_id=? AND lot=? AND verdict IN ('leading','not_leading')")
        .get(chatId,parsed.lot) as {amount:number|null};
      if (existing.amount!==null && parsed.amount<=existing.amount) {
        this.db.prepare('INSERT INTO auction_test_bids(message_id,chat_id,lot,amount,received_at_ms,verdict) VALUES (?,?,?,?,?,?)')
          .run(message.id,chatId,parsed.lot,parsed.amount,at,'duplicate_or_lower');
        return;
      }
      const previous=this.db.prepare("SELECT chat_id AS chatId,amount FROM auction_test_bids WHERE lot=? AND verdict='leading' ORDER BY amount DESC,received_at_ms ASC LIMIT 1")
        .get(parsed.lot) as {chatId:string;amount:number}|undefined;
      const leading=!previous || parsed.amount>previous.amount;
      const bidder=this.bidderNumber(chatId);
      const previousBidder=previous?this.bidderNumber(previous.chatId):undefined;
      this.db.prepare('INSERT INTO auction_test_bids(message_id,chat_id,lot,amount,received_at_ms,verdict) VALUES (?,?,?,?,?,?)')
        .run(message.id,chatId,parsed.lot,parsed.amount,at,leading?'leading':'not_leading');
      const text=[
        'CALMISTRY — TEST AUCTION',
        'TEST bid received and recorded. No real bid has been placed.',
        '',
        'Your test bidder number: '+bidder,
        'Lot: '+parsed.lot,
        'Your test bid: '+price(parsed.amount),
        'Status: '+(leading?'You are currently the highest TEST bidder.':'You are not currently the highest TEST bidder.'),
        '',
        'This is a private simulation. Bidder names are not disclosed.',
      ].filter((line,i,a)=>line!=='' || (i>0&&a[i-1]!=='')).join('\n');
      this.addNotice('confirmation',chatId,message.id,text,at);
      if (leading&&previous&&previous.chatId!==chatId&&previousBidder) {
        this.addNotice('outbid',previous.chatId,message.id,[
          'CALMISTRY — TEST AUCTION',
          'You have been outbid in the TEST auction on Lot '+parsed.lot+'.',
          'Your test bidder number: '+previousBidder,
          '',
          'No real auction result has changed.',
        ].join('\n'),at);
      }
    })();
    return true;
  }

  /** At most once, sequential private messages, with manual review on failure. */
  async flush() {
    if(!this.enabled || this.stopped || this.sending || Date.now()>=TEST_EXPIRES_AT ||
      !this.whatsapp.isAuthenticated()) return;
    this.sending=true;
    try {
      for(let i=0;i<8&&!this.stopped;i++) {
        const next=this.db.transaction(()=>{
          const row=this.db.prepare("SELECT id,chat_id AS chatId,text FROM auction_test_notices WHERE state='pending' ORDER BY id LIMIT 1").get() as Pending|undefined;
          if(!row)return undefined;
          this.db.prepare("UPDATE auction_test_notices SET state='sending' WHERE id=? AND state='pending'").run(row.id);
          return row;
        })();
        if(!next)break;
        try {
          const msg=await this.whatsapp.sendMessage(next.chatId,next.text);
          this.db.prepare("UPDATE auction_test_notices SET state='sent',sent_message_id=? WHERE id=? AND state='sending'").run(msg.id,next.id);
        }catch(e){
          this.db.prepare("UPDATE auction_test_notices SET state='uncertain',error=? WHERE id=? AND state='sending'")
            .run(String(e).slice(0,400),next.id);
          log.error('Test-auction WhatsApp reply uncertain; never auto-retrying',e);
        }
        if(i<7&&!this.stopped)await new Promise(resolve=>setTimeout(resolve,1500));
      }
    }finally{this.sending=false;}
  }

  stop(){this.stopped=true;}
  status(){
    const count=(table:string)=>(this.db.prepare('SELECT COUNT(*) AS n FROM '+table).get() as {n:number}).n;
    return {
      enabled:this.enabled && Date.now()<TEST_EXPIRES_AT,
      testBidders:count('auction_test_bidders'),
      testBids:count('auction_test_bids'),
      notices:this.db.prepare('SELECT kind,state,COUNT(*) AS n FROM auction_test_notices GROUP BY kind,state ORDER BY kind,state').all(),
      nextTestExpiredAt:new Date(TEST_EXPIRES_AT).toISOString(),
      note:'Test data and replies are separate from the actual auction. Only explicit TEST header messages trigger private replies.'
    };
  }
}
