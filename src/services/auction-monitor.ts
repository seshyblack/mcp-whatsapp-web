import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { SimpleMessage, WhatsAppBackend } from './backend.js';
import { log } from '../utils/logger.js';
import { AuctionBidderRegistry } from './auction-bidders.js';

const TWO_MINUTES = 120_000;
const START = Date.parse('2026-11-08T10:00:00+08:00');
const END = Date.parse('2026-11-22T21:00:00+08:00');
const OPENINGS: Readonly<Record<string, number>> = {
  '01':210,'02':870,'03':920,'04':240,'05':90,'06':260,'07':760,
  '08':190,'09':70,'10':260,'11':190,'12':190,'13':90,'14':80,
  '15':210,'16':240,'17':260,'18':120,'19':140,'20':130,'21':240,
  '22':90,'23':80,'24':70,'25':160,'26':80,'27':50,'28':120,
  '29':100,'30':70,'31':170,'32':90,'33':210,
};
type Mode = 'preview' | 'live';
interface ParsedBid { lot: string; amount: number; consent: boolean; }
interface Prior { chatId: string; amount: number; }
export function parseAuctionForm(body: string): ParsedBid | null {
  if (!/^CALMISTRY\s*[—-]\s*PRIVATE COLLECTION AUCTION\s*$/mi.test(body)) return null;
  const lot = body.match(/^Lot\s+(0[1-9]|[12][0-9]|3[0-3])\s*[—-]\s*[^\r\n]+$/mi);
  const bid = body.match(/^Bid:\s*SGD\s+([0-9][0-9,]*)\s*\(S\$\s*([0-9][0-9,]*)\)\s*$/mi);
  if (!lot || !bid) return { lot: '', amount: 0, consent: false };
  const amount = Number(bid[1]!.replace(/,/g,''));
  const repeat = Number(bid[2]!.replace(/,/g,''));
  const consent = /^(?:Auction rules|Bidding terms):\s*read and agreed\b/mi.test(body) &&
    /^Data consent:\s*agreed\b/mi.test(body) &&
    /^Payment and collection deadlines:\s*understood and agreed\b/mi.test(body) &&
    /^Full name:\s*\S+/mi.test(body) && /^WhatsApp:\s*\+/mi.test(body) &&
    /^Delivery address:\s*\r?\n\S+/mi.test(body);
  return {lot:lot[1]!,amount:Number.isSafeInteger(amount) && amount===repeat ? amount : 0,consent};
}

/* Runs outside ChatGPT, on the existing Render WhatsApp server.
   No WhatsApp sends and no website writes are possible in this class. */
export class AuctionSweepMonitor {
  private db: Database.Database;
  private bidders: AuctionBidderRegistry;
  private timer?: NodeJS.Timeout;
  private starter?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private running = false;
  private stopped = false;
  private error = '';
  constructor(private readonly whatsapp: WhatsAppBackend, dbPath: string,
    private readonly mode: Mode = 'preview',
    private readonly notificationsEnabled = false) {
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
  }
  start(): void {
    if (this.whatsapp.onIncomingMessage) this.unsubscribe = this.whatsapp.onIncomingMessage((m) => {
      try { if (this.record(m)) void this.bidders.flush(); } catch (e) { log.error('Auction monitoring intake failed:',e); }
    });
    this.timer = setInterval(()=>{void this.sweep();void this.bidders.flush();},TWO_MINUTES);
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
    const b=parseAuctionForm(m.body);
    if(!b || !m.id || !Number.isFinite(m.timestamp)) return false;
    if(this.db.prepare('SELECT 1 FROM monitored_bids WHERE message_id=?').get(m.id)) return false;
    const at=m.timestamp*1000;
    const opening=OPENINGS[b.lot];
    let verdict='preview';
    if(this.mode==='live'){
      if(at<START||at>=END) verdict='closed';
      else if(!opening||!b.consent||b.amount<opening||(b.amount-opening)%50!==0) verdict='invalid';
      else{
        const previous=this.db.prepare("SELECT chat_id AS chatId,amount FROM monitored_bids WHERE lot=? AND mode='live' AND verdict='accepted' ORDER BY amount DESC,received_at ASC LIMIT 1")
          .get(b.lot) as Prior|undefined;
        verdict=previous && b.amount<=previous.amount ? 'registered_not_leading' : 'accepted';
        this.db.transaction(() => {
          this.db.prepare('INSERT INTO monitored_bids(message_id,chat_id,lot,amount,received_at,mode,verdict) VALUES (?,?,?,?,?,?,?)')
            .run(m.id,m.chatId,b.lot,b.amount,at,this.mode,verdict);
          if(verdict==='accepted' && previous && previous.chatId!==m.chatId){
            this.db.prepare("INSERT OR IGNORE INTO outbid_drafts(lot,chat_id,replaced_by) VALUES (?,?,?)").run(b.lot,previous.chatId,m.id);
          }
          this.bidders.registerBid({ messageId:m.id, chatId:m.chatId, lot:b.lot,
            amount:b.amount, at, verdict:verdict==='accepted'?'accepted':'too_low', previous });
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
  status(){
    return {
      enabled:!this.stopped,mode:this.mode,frequencySeconds:120,
      lastCheck:this.state('last_check_ms')?new Date(Number(this.state('last_check_ms'))).toISOString():null,
      coverage:this.state('coverage')||'not_run',
      breakdown:this.db.prepare('SELECT verdict,COUNT(*) AS count FROM monitored_bids GROUP BY verdict').all(),
      leading:this.db.prepare("SELECT lot,MAX(amount) AS amountSgd FROM monitored_bids WHERE mode='live' AND verdict='accepted' GROUP BY lot ORDER BY lot").all(),
      outbidDrafts:(this.db.prepare("SELECT COUNT(*) AS n FROM outbid_drafts WHERE status='draft'").get() as {n:number}).n,
      lastError:this.error||null, messagesSent:0, websiteUpdates:0,
      note:'Preview is isolated from live bids. Multiple-quantity lots are held for review. Outbound disabled.'
    };
  }
}
