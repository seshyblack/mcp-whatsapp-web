import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuctionBidderRegistry } from '../src/services/auction-bidders.js';
import { AuctionSweepMonitor, applySarahStandardCancellation, parseAuctionFollowUp, parseAuctionForm } from '../src/services/auction-monitor.js';
import type { SimpleMessage, WhatsAppBackend } from '../src/services/backend.js';

const eventAt = Math.floor(Date.parse('2026-11-09T11:00:00+08:00') / 1000);

function websiteBid(lot: string, amount: number): string {
  return [
    'CALMISTRY — PRIVATE COLLECTION AUCTION',
    'Lot ' + lot + ' — Example piece',
    'Bid: SGD ' + amount + ' (S$' + amount + ')',
    'Full name: Example Guest',
    'WhatsApp: +6512345678',
    'Delivery address:',
    '10 Example Road Singapore 123456',
    'Bidding terms: read and agreed.',
    'Payment and collection deadlines: understood and agreed.',
    'Data consent: agreed.',
  ].join('\n');
}

function inbound(id: string, chatId: string, body: string): SimpleMessage {
  return { id, chatId, body, from: chatId, to: 'auction-owner',
    timestamp: eventAt, type: 'chat', fromMe: false, hasMedia: false };
}

function fakeBackend() {
  let incoming: (message: SimpleMessage) => void = () => {};
  const sent: Array<{ to: string; text: string }> = [];
  const whatsapp = {
    backend:'baileys',
    isAuthenticated: () => true,
    onIncomingMessage: (listener: (message: SimpleMessage) => void) => {
      incoming = listener;
      return () => { incoming = () => {}; };
    },
    listChats: async () => [],
    getMessages: async () => [],
    sendMessage: async (to: string, text: string) => {
      sent.push({to, text});
      return { id: 'wa-' + sent.length, timestamp: Date.now() / 1000 };
    },
  } as unknown as WhatsAppBackend;
  return { whatsapp, send: (m: SimpleMessage) => incoming(m), sent };
}

function compactWebsiteBid(lot: string, name: string, amount: number): string {
  const amt = amount.toLocaleString('en-SG');
  return [
    '*NEW BID — Lot ' + lot + ' · ' + name + ' · S$' + amt + '*',
    '',
    'Name: Example Guest',
    'WhatsApp: +6512345678',
    'Item: ' + name + ' (Lot ' + lot + ')',
    'Bid: S$' + amt,
    'Delivery: 10 Example Road, Singapore 123456',
    '',
    '────────────',
    '',
    '*Terms accepted*',
    '_Bidding rules agreed · Bank transfer within 24h of closing if successful · Collection within 7 days if self-collecting · Data consent granted · Bid valid upon Calmistry acknowledgement._',
  ].join('\n');
}

test('compact submission validates title, item, amount, contact, address and explicit terms', () => {
  const body = compactWebsiteBid('01', 'Alera Divider', 410);
  expect(parseAuctionForm(body)).toMatchObject({lot:'01', amount:410, consent:true, name:'Example Guest'});
  expect(parseAuctionForm(body.replace('Bid: S$410', 'Bid: S$500')))
    .toMatchObject({lot:'01',amount:0,consent:false});
  expect(parseAuctionForm(body.replace('Item: Alera Divider', 'Item: Another Divider')))
    .toMatchObject({lot:'01',amount:0,consent:false});
  expect(parseAuctionForm(body.replace('Data consent granted', 'Data consent withheld')))
    .toMatchObject({lot:'01',consent:false});
  expect(parseAuctionForm(body.replace('Delivery: 10 Example Road, Singapore 123456', 'Delivery:')))
    .toMatchObject({lot:'01',consent:false});
  expect(parseAuctionForm(body.replace('*Terms accepted*','*Terms not accepted*')))
    .toMatchObject({lot:'01',consent:false});
});

test('parses new form terms and only explicit short follow-up syntax', () => {
  expect(parseAuctionForm(websiteBid('02', 950))).toMatchObject({lot:'02',amount:950,consent:true});
  // Earlier website messages with both NEW BID title and legacy parser labels stay valid.
  expect(parseAuctionForm('*NEW BID — Lot 02 · Example piece · S$950*\n\n'+websiteBid('02', 950)))
    .toMatchObject({lot:'02',amount:950,consent:true});
  expect(parseAuctionForm(websiteBid('02', 950).replace('Payment and collection deadlines:', 'Payment deadline:')))
    .toMatchObject({consent:false});
  expect(parseAuctionFollowUp('Bid Lot 02: S$1050')).toMatchObject({lot:'02',amount:1050,followUp:true});
  expect(parseAuctionFollowUp('I might pay S$1120 for Lot 02')).toBeNull();
});

test('one stable private ID across lots, valid nonleading bids, outbid drafts and no preview sends', () => {
  const dir = mkdtempSync(path.join(tmpdir(),'calmistry-auction-test-'));
  const dbPath = path.join(dir,'auction.sqlite');
  const fake = fakeBackend();
  const monitor = new AuctionSweepMonitor(fake.whatsapp,dbPath,'live',false);
  const a='650000001@s.whatsapp.net', b='650000002@s.whatsapp.net';
  const c='650000003@s.whatsapp.net', unknown='650000004@s.whatsapp.net';
  try {
    monitor.start();
    fake.send(inbound('unknown',unknown,'Bid Lot 02: S$1050'));
    fake.send(inbound('a1',a,websiteBid('02', 950)));
    fake.send(inbound('b1',b,websiteBid('02', 1000)));
    fake.send(inbound('c1',c,websiteBid('02', 950)));
    fake.send(inbound('a2',a,'Bid Lot 02: S$1050'));
    fake.send(inbound('a3',a,'Bid Lot 06: S$350'));
    fake.send(inbound('a4',a,'Bid Lot 02: S$1050'));

    const state = monitor.status();
    expect(state.bidders.registeredBidders).toBe(3);
    expect(state.bidders.outboundEnabled).toBe(false);
    expect(state.messagesSent).toBe(0);
    expect(fake.sent).toHaveLength(0);
    const db = new Database(dbPath, { readonly:true });
    try {
      const people = db.prepare('SELECT id,chat_id AS chatId,public_number AS number FROM auction_bidders ORDER BY id').all() as Array<{id:number;chatId:string;number:number}>;
      expect(people.map(x=>({id:x.id,chatId:x.chatId}))).toEqual([{id:1,chatId:a},{id:2,chatId:b},{id:3,chatId:c}]);
      expect(new Set(people.map(x=>x.number)).size).toBe(3);
      expect(people.every(x=>x.number>=800 && x.number<=899)).toBe(true);
      const statuses = db.prepare('SELECT message_id AS id,verdict FROM monitored_bids ORDER BY rowid').all() as Array<{id:string;verdict:string}>;
      expect(statuses).toEqual([
        {id:'a1',verdict:'accepted'}, {id:'b1',verdict:'accepted'},
        {id:'c1',verdict:'registered_not_leading'}, {id:'a2',verdict:'accepted'},
        {id:'a3',verdict:'accepted'}, {id:'a4',verdict:'duplicate_or_lower'},
      ]);
      const notices=db.prepare('SELECT kind,text,state,chat_id AS chatId FROM auction_notices ORDER BY id').all() as Array<{kind:string;text:string;state:string;chatId:string}>;
      expect(notices).toHaveLength(8);
      expect(notices.every(n=>n.state==='draft')).toBe(true);
      expect(notices.filter(n=>n.kind==='outbid')).toHaveLength(2);
      expect(notices.filter(n=>n.kind==='unchanged')).toHaveLength(1);
      expect(notices.some(n=>/Bidder number: 8\d{2}/.test(n.text))).toBe(true);
      expect(notices.every(n=>!n.text.includes('Current highest bidder:'))).toBe(true);
      expect(notices.some(n=>n.text.includes('Status: *Not currently highest*'))).toBe(true);
      expect(notices.every(n=>!n.text.includes('Example Guest')&&!n.text.includes('12345678'))).toBe(true);
      const summary = monitor.closingReport();
      expect(summary).toContain('Lot 02 — Noma Drinks Cabinet');
      expect(summary).toContain('1. '+people[0]!.number+' · S$1,050');
      expect(summary).toContain('2. '+people[1]!.number+' · S$1,000');
      expect(summary).toContain('3. '+people[2]!.number+' · S$950');
      expect(summary).toContain('Lot 34 — Avami Leaf Pendant');
      expect(summary).toContain('OWNER REVIEW ONLY');
      expect(summary).not.toContain('B001');

    } finally { db.close(); }
  } finally {
    monitor.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('outbid notice shows own amount, new highest, stable private number and valid reply syntax', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'auction-outbid-copy-'));
  const db=new Database(path.join(dir,'auction.sqlite'));
  const fake=fakeBackend();
  const registry=new AuctionBidderRegistry(db,fake.whatsapp,false);
  try {
    registry.registerBid({messageId:'a1',chatId:'650000051@s.whatsapp.net',lot:'01',
      lotName:'Alera Divider',amount:400,at:Date.now(),verdict:'accepted'});
    registry.registerBid({messageId:'b1',chatId:'650000052@s.whatsapp.net',lot:'01',
      lotName:'Alera Divider',amount:490,at:Date.now(),verdict:'accepted',
      previous:{chatId:'650000051@s.whatsapp.net',amount:400}});
    const notices=db.prepare('SELECT kind,text,chat_id AS destination FROM auction_notices ORDER BY id')
      .all() as Array<{kind:string;text:string;destination:string}>;
    expect(notices).toHaveLength(3);
    const outbid=notices.find(x=>x.kind==='outbid')!;
    expect(outbid.destination).toBe('650000051@s.whatsapp.net');
    expect(outbid.text).toContain('*OUTBID — Lot 01 · Alera Divider*');
    expect(outbid.text).toContain('Your bid: S$400');
    expect(outbid.text).toContain('New highest bid: *S$490*');
    expect(outbid.text).toMatch(/Your bidder number: 8\d{2}/);
    expect(outbid.text).toContain('Minimum next bid: S$500');
    expect(outbid.text).toContain('Bid Lot 01: S$500');
    expect(parseAuctionFollowUp('Bid Lot 01: S$500')).toMatchObject({lot:'01',amount:500});
    expect(outbid.text).not.toContain('650000052');
    expect(notices[1]!.text).toContain('*BID RECEIVED — Lot 01 · Alera Divider · S$490*');
    expect(notices[1]!.text).toContain('Status: *Highest bid*');
    expect(notices.every(x=>!x.text.includes('CALMISTRY — PRIVATE COLLECTION'))).toBe(true);
  } finally { registry.stop(); db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('opted-in WhatsApp acknowledgement is private and marked sent only after receipt', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'calmistry-auction-notice-'));
  const db=new Database(path.join(dir,'auction.sqlite'));
  const fake=fakeBackend();
  const registry=new AuctionBidderRegistry(db,fake.whatsapp,true);
  try {
    registry.registerBid({messageId:'fresh1',chatId:'650000007@s.whatsapp.net',
      lot:'02',amount:950,at:Date.now(),verdict:'accepted'});
    expect(registry.status().noticeBreakdown).toMatchObject([{state:'pending',kind:'confirmation',count:1}]);
    await registry.flush();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].to).toBe('650000007@s.whatsapp.net');
    expect(fake.sent[0].text).toMatch(/Bidder number: 8\d{2}/);
    expect(fake.sent[0].text).toContain('Status: *Highest bid*');
    expect(registry.status().messagesSent).toBe(1);
    await registry.flush();
    expect(fake.sent).toHaveLength(1);
  } finally {
    registry.stop();
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('existing bidder IDs migrate to unique persistent random 8xx values', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'auction-migrate-'));
  const db=new Database(path.join(dir,'auction.sqlite'));
  const fake=fakeBackend();
  try {
    db.exec('CREATE TABLE auction_bidders (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL UNIQUE, first_bid_at INTEGER NOT NULL)');
    db.prepare('INSERT INTO auction_bidders(chat_id,first_bid_at) VALUES(?,?)').run('650000021@s.whatsapp.net',1);
    db.prepare('INSERT INTO auction_bidders(chat_id,first_bid_at) VALUES(?,?)').run('650000022@s.whatsapp.net',2);
    let first:number[];
    {
      const registry=new AuctionBidderRegistry(db,fake.whatsapp,false);
      first=(db.prepare('SELECT public_number AS n FROM auction_bidders ORDER BY id').all() as Array<{n:number}>).map(x=>x.n);
      registry.stop();
    }
    expect(first.every(n=>n>=800&&n<=899)).toBe(true);
    expect(new Set(first).size).toBe(2);
    const registry2=new AuctionBidderRegistry(db,fake.whatsapp,false);
    expect((db.prepare('SELECT public_number AS n FROM auction_bidders ORDER BY id').all() as Array<{n:number}>).map(x=>x.n)).toEqual(first);
    registry2.stop();
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('no bidder messages at or after close, and one owner-only top-three report', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'auction-owner-report-'));
  const dbPath=path.join(dir,'auction.sqlite');
  const fake=fakeBackend();
  const owner='6588741000@s.whatsapp.net';
  const monitor=new AuctionSweepMonitor(fake.whatsapp,dbPath,'live',false,false,owner);
  const a='650000031@s.whatsapp.net', b='650000032@s.whatsapp.net';
  const closing=Date.parse('2026-11-22T21:00:00+08:00');
  const clock=vi.spyOn(Date,'now');
  try {
    clock.mockReturnValue(Date.parse('2026-11-09T11:00:00+08:00'));
    monitor.start();
    fake.send(inbound('first',a,websiteBid('02', 950)));
    fake.send(inbound('second',b,websiteBid('02', 1000)));
    expect(fake.sent).toHaveLength(0);
    clock.mockReturnValue(closing+6*60_000);
    await monitor.sweep();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.to).toBe(owner);
    expect(fake.sent[0]!.text).toContain('Lot 02 — Noma Drinks Cabinet');
    expect(fake.sent[0]!.text).toContain('OWNER REVIEW ONLY');
    expect(fake.sent[0]!.text).toContain('No winners confirmed');
    await monitor.sweep();
    expect(fake.sent).toHaveLength(1);
    expect(monitor.status().ownerReportStatus).toMatch(/^sent:/);
  } finally {
    monitor.stop();
    clock.mockRestore();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('queued bidder acknowledgement is expired rather than sent when the auction closes', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'auction-stop-at-close-'));
  const db=new Database(path.join(dir,'auction.sqlite'));
  const fake=fakeBackend();
  const clock=vi.spyOn(Date,'now');
  const closing=Date.parse('2026-11-22T21:00:00+08:00');
  try {
    clock.mockReturnValue(closing-1000);
    const registry=new AuctionBidderRegistry(db,fake.whatsapp,true);
    registry.registerBid({messageId:'preclose',chatId:'650000039@s.whatsapp.net',lot:'02',
      amount:950,at:Date.now(),verdict:'accepted'});
    expect(registry.status().noticeBreakdown).toMatchObject([{state:'pending',kind:'confirmation',count:1}]);
    clock.mockReturnValue(closing);
    await registry.flush();
    expect(fake.sent).toHaveLength(0);
    expect(registry.status().noticeBreakdown).toMatchObject([{state:'expired',kind:'confirmation',count:1}]);
    registry.stop();
  } finally {
    clock.mockRestore();
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});


test('each valid lot gets a distinct status notice even when the same bidder bids on two lots', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'calmistry-multi-item-'));
  const dbPath=path.join(dir,'auction.sqlite');
  const fake=fakeBackend();
  const monitor=new AuctionSweepMonitor(fake.whatsapp,dbPath,'live',false);
  const a='650000091@s.whatsapp.net';
  const b='650000092@s.whatsapp.net';
  try {
    monitor.start();
    fake.send(inbound('other32',a,compactWebsiteBid('32','Auru Wall Accent (Elephant)',150)));
    fake.send(inbound('b32',b,compactWebsiteBid('32','Auru Wall Accent (Elephant)',130)));
    fake.send(inbound('b34',b,compactWebsiteBid('34','Avami Leaf Pendant',220)));
    const db=new Database(dbPath,{readonly:true});
    try {
      const notices=db.prepare('SELECT source_message_id AS source,kind,text FROM auction_notices WHERE chat_id=? ORDER BY id')
        .all(b) as Array<{source:string;kind:string;text:string}>;
      expect(notices).toHaveLength(2);
      expect(notices.map(n=>n.source)).toEqual(['b32','b34']);
      expect(notices[0]!.text).toContain('Lot 32');
      expect(notices[0]!.text).toContain('Status: *Not currently highest*');
      expect(notices[1]!.text).toContain('Lot 34');
      expect(notices[1]!.text).toContain('Status: *Highest bid*');
      const numbers=notices.map(n=>n.text.match(/Bidder number: (8\d{2})/)?.[1]);
      expect(numbers[0]).toBeDefined();
      expect(numbers[0]).toBe(numbers[1]);
    }finally{db.close();}
  }finally{monitor.stop();rmSync(dir,{recursive:true,force:true});}
});

test('each below-opening bid gets a private rejection with its own lot-specific minimum', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'calmistry-rejections-'));
  const dbPath=path.join(dir,'auction.sqlite');
  const fake=fakeBackend();
  const monitor=new AuctionSweepMonitor(fake.whatsapp,dbPath,'live',false);
  const guest='650000099@s.whatsapp.net';
  try {
    monitor.start();
    fake.send(inbound('low32',guest,compactWebsiteBid('32','Auru Wall Accent (Elephant)',120)));
    fake.send(inbound('low34',guest,compactWebsiteBid('34','Avami Leaf Pendant',210)));
    const db=new Database(dbPath,{readonly:true});
    try {
      const notices=db.prepare('SELECT kind,text FROM auction_notices WHERE chat_id=? ORDER BY id').all(guest) as Array<{kind:string;text:string}>;
      expect(notices).toHaveLength(2);
      expect(notices.every(n=>n.kind==='not_accepted')).toBe(true);
      expect(notices[0]!.text).toContain('S$130');
      expect(notices[1]!.text).toContain('S$220');
      expect(notices.every(n=>n.text.includes('No bid has been registered'))).toBe(true);
    }finally{db.close();}
  }finally{monitor.stop();rmSync(dir,{recursive:true,force:true});}
});

test('a complete formerly invalid bid can be reconciled once without duplicate receipts', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'calmistry-reconciliation-'));
  const dbPath=path.join(dir,'auction.sqlite');
  const fake=fakeBackend();
  const guest='650000090@s.whatsapp.net';
  const monitor=new AuctionSweepMonitor(fake.whatsapp,dbPath,'live',false);
  try {
    monitor.start();
    const db=new Database(dbPath);
    try {
      db.prepare('INSERT INTO monitored_bids(message_id,chat_id,lot,amount,received_at,mode,verdict) VALUES (?,?,?,?,?,?,?)')
        .run('formerly-invalid',guest,'34',220,eventAt*1000,'live','invalid');
      fake.send(inbound('formerly-invalid',guest,compactWebsiteBid('34','Avami Leaf Pendant',220)));
      fake.send(inbound('formerly-invalid',guest,compactWebsiteBid('34','Avami Leaf Pendant',220)));
      expect(db.prepare("SELECT verdict FROM monitored_bids WHERE message_id='formerly-invalid'").get())
        .toEqual({verdict:'accepted'});
      const notices=db.prepare("SELECT text FROM auction_notices WHERE source_message_id='formerly-invalid'").all() as Array<{text:string}>;
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain('BID CORRECTED');
    }finally{db.close();}
  }finally{monitor.stop();rmSync(dir,{recursive:true,force:true});}
});

test('owner-authorized Standard Avami cancellation keeps other Sarah bids and prevents old-bid replay', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'calmistry-sarah-cancel-'));
  const dbPath=path.join(dir,'auction.sqlite');
  const fake=fakeBackend();
  const monitor=new AuctionSweepMonitor(fake.whatsapp,dbPath,'live',false);
  const sarah='601139700824@s.whatsapp.net', other='650000099@s.whatsapp.net';
  try {
    monitor.start();
    fake.send(inbound('sarah21',sarah,compactWebsiteBid('21','Avami Leaf Pendant - Grande',260)));
    fake.send(inbound('sarah32',sarah,compactWebsiteBid('32','Auru Wall Accent (Elephant)',130)));
    const db=new Database(dbPath);
    try {
      db.prepare('INSERT INTO monitored_bids (message_id,chat_id,lot,amount,received_at,mode,verdict) VALUES (?,?,?,?,?,?,?)')
        .run('sarah34',sarah,'34',220,eventAt*1000,'live','accepted');
      db.prepare('INSERT INTO monitored_bids (message_id,chat_id,lot,amount,received_at,mode,verdict) VALUES (?,?,?,?,?,?,?)')
        .run('other34',other,'34',220,(eventAt+1)*1000,'live','registered_not_leading');
      const result=applySarahStandardCancellation(db);
      expect(result).toMatchObject({cancelled:1,lot32Status:'highest',lot32Highest:130,lot34RemainingHighest:220});
      expect(db.prepare("SELECT verdict FROM monitored_bids WHERE message_id='sarah34'").get())
        .toEqual({verdict:'cancelled'});
      expect(db.prepare("SELECT verdict FROM monitored_bids WHERE message_id='other34'").get())
        .toEqual({verdict:'accepted'});
      expect(db.prepare("SELECT verdict FROM monitored_bids WHERE message_id='sarah21'").get())
        .toEqual({verdict:'accepted'});
      expect(db.prepare("SELECT verdict FROM monitored_bids WHERE message_id='sarah32'").get())
        .toEqual({verdict:'accepted'});
      // A new sweep cannot bring back the original cancelled bid.
      fake.send(inbound('sarah34',sarah,compactWebsiteBid('34','Avami Leaf Pendant',220)));
      expect(db.prepare("SELECT verdict FROM monitored_bids WHERE message_id='sarah34'").get())
        .toEqual({verdict:'cancelled'});
      const again=applySarahStandardCancellation(db);
      expect(again.cancelled).toBe(0);
      fake.send(inbound('higher32',other,compactWebsiteBid('32','Auru Wall Accent (Elephant)',140)));
      expect(applySarahStandardCancellation(db).lot32Status).toBe('not_highest');
    } finally {db.close();}
  } finally {monitor.stop();rmSync(dir,{recursive:true,force:true});}
});
