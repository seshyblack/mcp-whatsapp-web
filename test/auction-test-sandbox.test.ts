import { test, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AuctionTestSandbox, TEST_BID_HEADER } from '../src/services/auction-test-sandbox.js';
import { parseAuctionForm } from '../src/services/auction-monitor.js';
import type { SimpleMessage, WhatsAppBackend } from '../src/services/backend.js';

const WHEN = Date.parse('2026-11-05T01:33:00.000Z');
function inbound(id:string, chatId:string, body:string):SimpleMessage {
  return {id,chatId,body,from:chatId,to:'owner',timestamp:WHEN/1000,fromMe:false,hasMedia:false,type:'chat'};
}
function draft(lot:string,amount:number):string {
  return [
    TEST_BID_HEADER,
    'Lot '+lot+' — Example auction piece',
    'Bid: SGD '+amount+' (S$'+amount+')',
    '',
    'Full name: Test Buyer',
    'WhatsApp: +6599999999',
    '',
    'Delivery address:',
    '10 Example Street Singapore 123456',
    '',
    'Bidding terms: read and agreed.',
    'Payment and collection deadlines: understood and agreed.',
    'Data consent: agreed.',
  ].join('\n');
}
function backend() {
  const sent: Array<{to:string;text:string}>=[];
  const wa = {
    isAuthenticated:()=>true,
    sendMessage:async(to:string,text:string)=> {
      sent.push({to,text});
      return {id:'fake-'+sent.length,timestamp:WHEN/1000};
    },
  } as WhatsAppBackend;
  return {wa,sent};
}
const openings={ '02':870,'04':240 };

test('sandbox assigns stable private IDs, replies leading/nonleading and outbid without real bids',async()=>{
  const clock=vi.spyOn(Date,'now').mockReturnValue(WHEN);
  const db=new Database(':memory:');
  const {wa,sent}=backend();
  try {
    const sandbox=new AuctionTestSandbox(db,wa,true);
    const first='6511111111@s.whatsapp.net',second='6522222222@s.whatsapp.net',third='6533333333@s.whatsapp.net';
    expect(sandbox.record(inbound('a1',first,draft('02',870)),parseAuctionForm,openings)).toBe(true);
    expect(sandbox.record(inbound('b1',second,draft('02',920)),parseAuctionForm,openings)).toBe(true);
    expect(sandbox.record(inbound('c1',third,draft('02',870)),parseAuctionForm,openings)).toBe(true);
    expect(sandbox.record(inbound('a2',first,draft('04',240)),parseAuctionForm,openings)).toBe(true);
    expect(sandbox.record(inbound('a1',first,draft('02',870)),parseAuctionForm,openings)).toBe(false);
    expect(sandbox.status().testBidders).toBe(3);
    expect(sandbox.status().testBids).toBe(4);
    const pending=db.prepare("SELECT kind,state,chat_id AS chatId,text FROM auction_test_notices ORDER BY id").all() as Array<{kind:string;state:string;chatId:string;text:string}>;
    expect(pending).toHaveLength(5);
    expect(pending.every(x=>x.state==='pending')).toBe(true);
    expect(pending.filter(x=>x.kind==='outbid')).toHaveLength(1);
    expect(pending.some(x=>x.text.includes('Your test bidder number: B001'))).toBe(true);
    expect(pending.some(x=>x.text.includes('Your test bidder number: B002'))).toBe(true);
    expect(pending.some(x=>x.text.includes('highest TEST bidder: B002'))).toBe(true);
    expect(pending.some(x=>x.text.includes('You are not currently the highest TEST bidder.'))).toBe(true);
    expect(pending.every(x=>x.text.includes('TEST'))).toBe(true);
    expect(sandbox.record(inbound('normal',first,draft('02',970).replace(TEST_BID_HEADER,'CALMISTRY — PRIVATE COLLECTION AUCTION')),parseAuctionForm,openings)).toBe(false);
    expect(sandbox.record(inbound('malformed',first,draft('02',970).replace('Data consent: agreed.', 'Data consent: denied.')),parseAuctionForm,openings)).toBe(false);
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>;
    expect(tables.some(x=>x.name==='monitored_bids'||x.name==='auction_bidders'||x.name==='auction_notices')).toBe(false);
    await sandbox.flush();
    expect(sent).toHaveLength(5);
    expect(sent.every(x=>[first,second,third].includes(x.to))).toBe(true);
    expect(sent.every(x=>x.text.includes('TEST'))).toBe(true);
    await sandbox.flush();
    expect(sent).toHaveLength(5);
    sandbox.stop();
  } finally {clock.mockRestore();db.close();}
},18000);

test('test replies disabled by default and expire when auction opens', async()=>{
  const clock=vi.spyOn(Date,'now').mockReturnValue(WHEN);
  const db=new Database(':memory:');
  const {wa,sent}=backend();
  try {
    const sandbox=new AuctionTestSandbox(db,wa,false);
    expect(sandbox.record(inbound('never','6511111111@s.whatsapp.net',draft('02',870)),parseAuctionForm,openings)).toBe(false);
    await sandbox.flush();
    expect(sent).toHaveLength(0);
    clock.mockReturnValue(Date.parse('2026-11-08T10:00:00+08:00'));
    expect(sandbox.record(inbound('expired','6511111111@s.whatsapp.net',draft('02',870)),parseAuctionForm,openings)).toBe(false);
    expect(sandbox.status().enabled).toBe(false);
  } finally {clock.mockRestore();db.close();}
});
