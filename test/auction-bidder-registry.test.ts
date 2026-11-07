import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuctionBidderRegistry } from '../src/services/auction-bidders.js';
import { AuctionSweepMonitor, parseAuctionFollowUp, parseAuctionForm } from '../src/services/auction-monitor.js';
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

test('parses new form terms and only explicit short follow-up syntax', () => {
  expect(parseAuctionForm(websiteBid('02', 1020))).toMatchObject({lot:'02',amount:1020,consent:true});
  expect(parseAuctionForm(websiteBid('02', 1020).replace('Payment and collection deadlines:', 'Payment deadline:')))
    .toMatchObject({consent:false});
  expect(parseAuctionFollowUp('Bid Lot 02: S$1120')).toMatchObject({lot:'02',amount:1120,followUp:true});
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
    fake.send(inbound('unknown',unknown,'Bid Lot 02: S$1120'));
    fake.send(inbound('a1',a,websiteBid('02',1020)));
    fake.send(inbound('b1',b,websiteBid('02',1070)));
    fake.send(inbound('c1',c,websiteBid('02',1020)));
    fake.send(inbound('a2',a,'Bid Lot 02: S$1120'));
    fake.send(inbound('a3',a,'Bid Lot 06: S$360'));
    fake.send(inbound('a4',a,'Bid Lot 02: S$1120'));

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
      expect(notices).toHaveLength(7);
      expect(notices.every(n=>n.state==='draft')).toBe(true);
      expect(notices.filter(n=>n.kind==='outbid')).toHaveLength(2);
      expect(notices.some(n=>/Your bidder number · 8\d{2}/.test(n.text))).toBe(true);
      expect(notices.every(n=>!n.text.includes('Current highest bidder:'))).toBe(true);
      expect(notices.some(n=>n.text.includes('You are not currently the highest bidder for Lot 02.'))).toBe(true);
      expect(notices.every(n=>!n.text.includes('Example Guest')&&!n.text.includes('12345678'))).toBe(true);
      const summary = monitor.closingReport();
      expect(summary).toContain('Lot 02 — Noma Drinks Cabinet');
      expect(summary).toContain('1. '+people[0]!.number+' · S$1,120');
      expect(summary).toContain('2. '+people[1]!.number+' · S$1,070');
      expect(summary).toContain('3. '+people[2]!.number+' · S$1,020');
      expect(summary).toContain('Lot 34 — Avami Leaf Pendant');
      expect(summary).toContain('OWNER REVIEW ONLY');
      expect(summary).not.toContain('B001');

    } finally { db.close(); }
  } finally {
    monitor.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('opted-in WhatsApp acknowledgement is private and marked sent only after receipt', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'calmistry-auction-notice-'));
  const db=new Database(path.join(dir,'auction.sqlite'));
  const fake=fakeBackend();
  const registry=new AuctionBidderRegistry(db,fake.whatsapp,true);
  try {
    registry.registerBid({messageId:'fresh1',chatId:'650000007@s.whatsapp.net',
      lot:'02',amount:1020,at:Date.now(),verdict:'accepted'});
    expect(registry.status().noticeBreakdown).toMatchObject([{state:'pending',kind:'confirmation',count:1}]);
    await registry.flush();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].to).toBe('650000007@s.whatsapp.net');
    expect(fake.sent[0].text).toMatch(/Your bidder number · 8\d{2}/);
    expect(fake.sent[0].text).toContain('You are currently the highest bidder');
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
