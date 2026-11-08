import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SimpleMessage, WhatsAppBackend } from './backend.js';
import { log } from '../utils/logger.js';
import { AuctionBidderRegistry } from './auction-bidders.js';
import { validAuctionBidAmount } from './auction-pricing.js';
import { AuctionTestSandbox } from './auction-test-sandbox.js';
import { removeKnownOpeningTestBids, isDeletedAuctionTestMessage } from './auction-test-cleanup.js';
import { resetAuctionExcludingClairie, isExcludedAuctionSender } from './auction-exclusions.js';

const TWO_MINUTES = 120_000;
const START = Date.parse('2026-11-08T10:00:00+08:00');
const END = Date.parse('2026-11-22T21:00:00+08:00');
const OWNER_REPORT_GRACE = 5 * 60_000;
const LOT_NAMES: Record<string,string> = Object.fromEntries([
  'Alera Divider','Noma Drinks Cabinet','Noma Cocktail Cabinet','Narana Screen Divider',
  'Auru Wall Accent (Giraffe)','Avara Bar Stool','Taj Round Table','Luma Decorative Panel',
  'Varen Stool','Alera Coffee Table','Tanu Coffee Table','Senai Dining Chair',
  'Veya Dining Chair','Naro Dining Chair','Lione Armchair','Bonnie Coffee Table',
  'Soma Drinks Trolley','Zianna Curves Stool','Auri Armchair','Lora Pendant 90cm',
  'Avami Leaf Pendant - Grande','Talo Pendant','Lora Pendant 50cm','Velin Pendant',
  'Taro Headboard','Luma Mirror','Sona Pendant','Liora Headboard',
  'Maro Accent Stool','Auru Wall Accent (Lion)','Suri Pendant','Auru Wall Accent (Elephant)',
  'Veyana Screen Divider','Avami Leaf Pendant',
].map((name,i)=>[String(i+1).padStart(2,'0'),name]));
export const OPENINGS: Readonly<Record<string, number>> = {
  '01':410,'02':1020,'03':1040,'04':350,'05':140,'06':360,'07':760,
  '08':190,'09':70,'10':410,'11':190,'12':230,'13':90,'14':80,
  '15':270,'16':290,'17':330,'18':120,'19':140,'20':130,'21':240,
  '22':90,'23':80,'24':70,'25':160,'26':80,'27':50,'28':120,
  '29':100,'30':140,'31':170,'32':140,'33':390,'34':230
};
type Mode = 'preview' | 'live';
interface ParsedBid { lot: string; amount: number; consent: boolean; followUp?: boolean; name?: string; }
interface Prior { chatId: string; amount: number; }
export function parseAuctionForm(body: string): ParsedBid | null {
  // Compact WhatsApp bid form (8 Nov 2026). Accept only complete submissions:
  // title, item, amount, identity, address and affirmative, unchanged terms.
  // Older messages remain supported below for bids already in the WhatsApp history.
  const compact = body.match(/^\*NEW BID\s*[—-]\s*Lot\s+(0[1-9]|[12][0-9]|3[0-4])\s*·\s*(.+?)\s*·\s*S\$\s*([0-9][0-9,]*)\*\s*$/mi);
  // Legacy 8 Nov submissions also had the NEW BID title but retained the
  // old CALMISTRY parser header. Continue to accept those in-flight messages.
  if (compact && !/^CALMISTRY\s*[—-]\s*PRIVATE COLLECTION AUCTION\s*$/mi.test(body)) {
    const item = body.match(/^Item:\s*(.+?)\s*\(Lot\s+(0[1-9]|[12][0-9]|3[0-4])\)\s*$/mi);
    const amountField = body.match(/^Bid:\s*S\$\s*([0-9][0-9,]*)\s*$/mi);
    const name = body.match(/^Name:\s*(.+?)\s*$/mi)?.[1]?.trim();
    const phone = body.match(/^WhatsApp:\s*(\+[1-9]\d{7,14})\s*$/mi);
    const delivery = body.match(/^Delivery:\s*(.+?)\s*$/mi)?.[1]?.trim();
    const compactTerms = [
      /^\*Terms accepted\*\s*$/mi,
      /^_Bidding rules agreed · Bank transfer within 24h of closing if successful · Collection within 7 days if self-collecting · Data consent granted · Bid valid upon Calmistry acknowledgement\._\s*$/mi,
    ].every(pattern => pattern.test(body));
    const amount = Number(compact[3]!.replace(/,/g, ''));
    const repeated = amountField ? Number(amountField[1]!.replace(/,/g, '')) : 0;
    const coherent = item?.[2] === compact[1] &&
      item?.[1]?.trim() === compact[2]?.trim() &&
      Number.isSafeInteger(amount) && amount === repeated;
    const consent = !!(coherent && name && name.length >= 2 && phone &&
      delivery && delivery.length >= 15 && compactTerms);
    return { lot: compact[1]!, amount: coherent ? amount : 0, consent, name };
  }
  if (!/^CALMISTRY\s*[—-]\s*PRIVATE COLLECTION AUCTION\s*$/mi.test(body)) return null;
  const lot = body.match(/^Lot\s+(0[1-9]|[12][0-9]|3[0-4])\s*[—-]\s*[^\r\n]+$/mi);
  const bid = body.match(/^Bid:\s*SGD\s+([0-9][0-9,]*)\s*\(S\$\s*([0-9][0-9,]*)\)\s*$/mi);
  if (!lot || !bid) return { lot: '', amount: 0, consent: false };
  const amount = Number(bid[1]!.replace(/,/g,''));
  const repeat = Number(bid[2]!.replace(/,/g,''));
  const consent = /^(?:Auction rules|Bidding terms):\s*read and agreed\b/mi.test(body) &&
    /^Data consent:\s*agreed\b/mi.test(body) &&
    /^Payment and collection deadlines:\s*understood and agreed\b/mi.test(body) &&
    /^Full name:\s*\S+/mi.test(body) && /^WhatsApp:\s*\+/mi.test(body) &&
    /^Delivery address:\s*\r?\n\S+/mi.test(body);
  const name = body.match(/^Full name:\s*(.+)\s*$/mi)?.[1]?.trim();
  return {lot:lot[1]!,amount:Number.isSafeInteger(amount) && amount===repeat ? amount : 0,consent,name};
}

/** Optional short follow-up format for already registered bidders only. */
export function parseAuctionFollowUp(body: string): ParsedBid | null {
  const match = body.trim().match(/^Bid\s+Lot\s+(0[1-9]|[12][0-9]|3[0-4])\s*:\s*S\$\s*([1-9][0-9]{0,8})$/i);
  if (!match) return null;
  const amount = Number(match[2]);
  return { lot:match[1]!, amount, consent:Number.isSafeInteger(amount), followUp:true };
}

/* Runs outside ChatGPT, on the existing Render WhatsApp server.
   No WhatsApp sends and no website writes are possible in this class. */
export class AuctionSweepMonitor {
  private db: Database.Database;
  private bidders: AuctionBidderRegistry;
  private tests: AuctionTestSandbox;
  private timer?: NodeJS.Timeout;
  private starter?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private running = false;
  private stopped = false;
  private error = '';
  private ownerSending = false;
  constructor(private readonly whatsapp: WhatsAppBackend, dbPath: string,
    private readonly mode: Mode = 'preview',
    private readonly notificationsEnabled = false,
    private readonly testRepliesEnabled = false,
    private readonly ownerReportJid: string | null = null) {
    mkdirSync(path.dirname(dbPath),{recursive:true,mode:0o700});
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS monitored_bids (message_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,lot TEXT NOT NULL,amount INTEGER NOT NULL,received_at INTEGER NOT NULL,mode TEXT NOT NULL,verdict TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS monitored_rank ON monitored_bids(lot,mode,verdict,amount)",
      "CREATE TABLE IF NOT EXISTS monitor_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS outbid_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT,lot TEXT NOT NULL,chat_id TEXT NOT NULL,replaced_by TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',UNIQUE(lot,chat_id,replaced_by))"
    ].join(';')+';');
    this.bidders = new AuctionBidderRegistry(this.db, this.whatsapp,
      this.mode === 'live' && this.notificationsEnabled);
    this.tests = new AuctionTestSandbox(this.db,this.whatsapp,
      this.mode === 'preview' && this.testRepliesEnabled);
    if (this.mode === 'live') {
      removeKnownOpeningTestBids(this.db);
      resetAuctionExcludingClairie(this.db, OPENINGS['01']);
    }
  }
  start(): void {
    if (this.whatsapp.onIncomingMessage) this.unsubscribe = this.whatsapp.onIncomingMessage((m) => {
      try { if(this.record(m)){ void this.bidders.flush(); void this.tests.flush(); } } catch(e){log.error('Auction monitoring intake failed:',e);}
    });
    this.timer = setInterval(()=>{void this.sweep();void this.bidders.flush();void this.tests.flush();},TWO_MINUTES);
    this.timer.unref?.();
    this.starter = setTimeout(()=>{void this.sweep();},12_000);
    this.starter.unref?.();
    log.info('Calmistry two-minute auction monitor scheduled. Mode='+this.mode+', outbound='+ (this.mode==='live'&&this.notificationsEnabled));
  }
  stop(): void {
    this.stopped=true;
    if(this.timer) clearInterval(this.timer);
    if(this.starter) clearTimeout(this.starter);
    this.unsubscribe?.();
    this.bidders.stop();
    this.tests.stop();
    this.db.close();
  }
  private state(k:string):string|undefined {
    return (this.db.prepare('SELECT value FROM monitor_state WHERE key=?').get(k) as {value:string}|undefined)?.value;
  }
  private setState(k:string,v:string):void {
    this.db.prepare('INSERT INTO monitor_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,v);
  }
  private record(m:SimpleMessage):boolean {
    if(this.stopped || m.fromMe || m.type!=='chat' || !/^\d+@(s\.whatsapp\.net|lid)$/.test(m.chatId||'')) return false;
    if (this.mode === 'live' && isExcludedAuctionSender(m.chatId)) return false;
    if (this.mode === 'live' && m.id && isDeletedAuctionTestMessage(this.db, m.id)) return false;
    if(this.mode==='preview' && this.tests.record(m,parseAuctionForm,OPENINGS)) return true;
    const b=parseAuctionForm(m.body) ?? parseAuctionFollowUp(m.body);
    if(!b || !m.id || !Number.isFinite(m.timestamp)) return false;
    if(b.followUp && !this.db.prepare('SELECT 1 FROM auction_bidders WHERE chat_id=?').get(m.chatId)) return false;
    if(this.db.prepare('SELECT 1 FROM monitored_bids WHERE message_id=?').get(m.id)) return false;
    const at=m.timestamp*1000;
    const opening=OPENINGS[b.lot];
    let verdict='preview';
    if(this.mode==='live'){
      if(at<START||at>=END) verdict='closed';
      else if(!b.consent||!validAuctionBidAmount(opening,b.amount)) verdict='invalid';
      else{
        const own=this.db.prepare("SELECT MAX(amount) AS amount FROM monitored_bids WHERE lot=? AND chat_id=? AND mode='live' AND verdict IN ('accepted','registered_not_leading')")
          .get(b.lot,m.chatId) as { amount:number|null };
        if(own.amount!==null && b.amount<=own.amount) {
          this.db.prepare('INSERT INTO monitored_bids(message_id,chat_id,lot,amount,received_at,mode,verdict) VALUES (?,?,?,?,?,?,?)')
            .run(m.id,m.chatId,b.lot,b.amount,at,this.mode,'duplicate_or_lower');
          return true;
        }
        const previous=this.db.prepare("SELECT chat_id AS chatId,amount FROM monitored_bids WHERE lot=? AND mode='live' AND verdict='accepted' ORDER BY amount DESC,received_at ASC LIMIT 1")
          .get(b.lot) as Prior|undefined;
        verdict=previous && b.amount<=previous.amount ? 'registered_not_leading' : 'accepted';
        this.db.transaction(() => {
          this.db.prepare('INSERT INTO monitored_bids(message_id,chat_id,lot,amount,received_at,mode,verdict) VALUES (?,?,?,?,?,?,?)')
            .run(m.id,m.chatId,b.lot,b.amount,at,this.mode,verdict);
          if(verdict==='accepted' && previous && previous.chatId!==m.chatId){
            this.db.prepare("INSERT OR IGNORE INTO outbid_drafts(lot,chat_id,replaced_by) VALUES (?,?,?)").run(b.lot,previous.chatId,m.id);
          }
          this.bidders.registerBid({ messageId:m.id, chatId:m.chatId!, lot:b.lot,
            amount:b.amount, at, verdict:verdict==='accepted'?'accepted':'too_low', previous, name:b.name,
            lotName:LOT_NAMES[b.lot] || 'Auction item' });
        })();
        return true;
      }
    }
    this.db.prepare('INSERT INTO monitored_bids(message_id,chat_id,lot,amount,received_at,mode,verdict) VALUES (?,?,?,?,?,?,?)')
      .run(m.id,m.chatId,b.lot,b.amount,at,this.mode,verdict);
    return true;
  }
  async sweep():Promise<void>{
    if(this.stopped||this.running) return;
    this.running=true;
    const now=Date.now();
    let inspected=0,newBids=0,partial=false;
    try{
      if(!this.whatsapp.isAuthenticated()) throw new Error('WhatsApp connection is offline');
      const last=Number(this.state('last_success_ms')||0);
      const since=Math.max(now-24*3600_000,last?last-10*60_000:now-3600_000);
      const chats=await this.whatsapp.listChats(1000,false);
      const recent=chats.filter(c=>!c.isGroup && /^\d+@(s\.whatsapp\.net|lid)$/.test(c.id) && c.timestamp*1000>=since);
      if(recent.length>150) partial=true;
      for(let i=0;i<Math.min(recent.length,150);i+=8){
        await Promise.all(recent.slice(i,i+8).map(async c=>{
          try{
            const items=await this.whatsapp.getMessages(c.id,60);
            inspected++;
            for(const m of items) if(m.timestamp*1000>=since && this.record(m)) newBids++;
          }catch(e){partial=true;log.warn('Auction chat could not be scanned',e);}
        }));
      }
      await this.bidders.flush();
      await this.tests.flush();
      // No bidder messages after close. Only the owner receives one final report.
      if (this.mode === 'live' && Date.now() >= END + OWNER_REPORT_GRACE &&
          !partial) await this.sendOwnerReport();
      this.setState('last_check_ms',String(Date.now()));
      this.setState('coverage',partial?'partial':'complete');
      if(!partial) this.setState('last_success_ms',String(now));
      this.error='';
      log.info('Auction monitor sweep '+JSON.stringify({mode:this.mode,inspected,newBids,partial,sent:0}));
    }catch(e){
      this.error=e instanceof Error?e.message:String(e);
      this.setState('last_check_ms',String(Date.now()));
      this.setState('coverage','error');
      log.error('Auction monitor sweep failed: '+this.error);
    }finally{this.running=false;}
  }


  /** Three highest distinct bidders by their best VALID pre-close bid on each lot. */
  closingReport(): string {
    const lines = [
      'CALMISTRY — PRIVATE AUCTION / OWNER REPORT',
      'Closed 22 Nov 2026, 9pm (GMT+8)',
      'Top three unique bidders per lot. No winners confirmed; check reserves manually.',
      '',
    ];
    const ranked = this.db.prepare([
      'SELECT b.lot, b.chat_id AS chatId, MAX(b.amount) AS amount,',
      'p.public_number AS bidderNumber, p.display_name AS name,',
      'MIN(b.received_at) AS firstAt',
      'FROM monitored_bids b JOIN auction_bidders p ON p.chat_id=b.chat_id',
      "WHERE b.mode='live' AND b.verdict IN ('accepted','registered_not_leading')",
      'AND b.received_at>=? AND b.received_at<?',
      'GROUP BY b.lot,b.chat_id',
      'ORDER BY b.lot, amount DESC, firstAt ASC',
    ].join(' ')).all(START,END) as Array<{
      lot:string;chatId:string;amount:number;bidderNumber:number;name:string|null;firstAt:number;
    }>;
    for (let i=1;i<=34;i++) {
      const lot=String(i).padStart(2,'0');
      const candidates=ranked.filter(x=>x.lot===lot).slice(0,3);
      lines.push('Lot '+lot+' — '+LOT_NAMES[lot]);
      if (!candidates.length) { lines.push('  No valid bids'); continue; }
      for (const [rank,bid] of candidates.entries()) {
        lines.push('  '+(rank+1)+'. '+bid.bidderNumber+' · S$'+bid.amount.toLocaleString('en-SG')+
          (bid.name?' · '+bid.name:'')+' · '+bid.chatId);
      }
    }
    lines.push('', 'OWNER REVIEW ONLY — check reserves and contact successful bidders manually.');
    return lines.join('\n');
  }

  /** At most one owner send. If delivery is uncertain, never automatically retry. */
  private async sendOwnerReport(): Promise<void> {
    if (this.ownerSending || !this.ownerReportJid ||
      !/^\d+@s\.whatsapp\.net$/.test(this.ownerReportJid) ||
      this.state('owner_report_status') || !this.whatsapp.isAuthenticated()) return;
    this.ownerSending=true;
    try {
      this.setState('owner_report_status','sending');
      const sent=await this.whatsapp.sendMessage(this.ownerReportJid,this.closingReport());
      this.setState('owner_report_status','sent:'+sent.id);
    } catch (error) {
      this.setState('owner_report_status','uncertain');
      log.error('Calmistry owner closing report delivery uncertain; no automatic retry',error);
    } finally { this.ownerSending=false; }
  }
  status() {
    return {
      enabled:!this.stopped,mode:this.mode,frequencySeconds:120,
      ownerReportStatus:this.state('owner_report_status')||'not_sent',
      lastCheck:this.state('last_check_ms')?new Date(Number(this.state('last_check_ms'))).toISOString():null,
      coverage:this.state('coverage')||'not_run',
      breakdown:this.db.prepare('SELECT verdict,COUNT(*) AS count FROM monitored_bids GROUP BY verdict').all(),
      leading:this.db.prepare("SELECT lot,MAX(amount) AS amountSgd FROM monitored_bids WHERE mode='live' AND verdict='accepted' GROUP BY lot ORDER BY lot").all(),
      outbidDrafts:(this.db.prepare("SELECT COUNT(*) AS n FROM outbid_drafts WHERE status='draft'").get() as {n:number}).n,
      bidders:this.bidders.status(),
      testSandbox:this.tests.status(),
      lastError:this.error||null,messagesSent:this.bidders.status().messagesSent,websiteUpdates:0,
      note:'Immediate private outbid notices while open. No bidder sends after close; owner-only top three report.',
    };
  }
}
