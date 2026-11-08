import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { removeKnownOpeningTestBids, isDeletedAuctionTestMessage } from '../src/services/auction-test-cleanup.js';

const testsAt = Date.parse('2026-11-08T02:43:00.000Z');
function fixture() {
  const db = new Database(':memory:');
  db.exec([
    "CREATE TABLE monitored_bids(message_id TEXT PRIMARY KEY,chat_id TEXT,lot TEXT,amount INTEGER,received_at INTEGER,mode TEXT,verdict TEXT)",
    "CREATE TABLE auction_bidders(id INTEGER PRIMARY KEY,chat_id TEXT UNIQUE,first_bid_at INTEGER,public_number INTEGER,display_name TEXT)",
    "CREATE TABLE auction_notices(id INTEGER PRIMARY KEY,source_message_id TEXT,kind TEXT,state TEXT)",
    "CREATE TABLE outbid_drafts(id INTEGER PRIMARY KEY,replaced_by TEXT)",
    "CREATE TABLE monitor_state(key TEXT PRIMARY KEY,value TEXT)",
  ].join(';') + ';');
  const add=db.prepare('INSERT INTO monitored_bids VALUES(?,?,?,?,?,?,?)');
  for(const a of [410,420,500]) add.run('test-'+a,'6588747000@s.whatsapp.net','01',a,testsAt,'live','accepted');
  add.run('real-600','6590000000@s.whatsapp.net','01',600,testsAt,'live','accepted');
  add.run('real-120','6590000000@s.whatsapp.net','02',120,testsAt,'live','registered_not_leading');
  db.prepare('INSERT INTO auction_bidders VALUES(?,?,?,?,?)').run(1,'6588747000@s.whatsapp.net',testsAt,827,'Shyann Seet');
  db.prepare('INSERT INTO auction_bidders VALUES(?,?,?,?,?)').run(2,'6590000000@s.whatsapp.net',testsAt,868,'Real Buyer');
  db.prepare('INSERT INTO auction_notices VALUES(?,?,?,?)').run(1,'test-410','confirmation','sent');
  db.prepare('INSERT INTO auction_notices VALUES(?,?,?,?)').run(2,'test-500','confirmation','pending');
  db.prepare('INSERT INTO auction_notices VALUES(?,?,?,?)').run(3,'real-600','confirmation','sent');
  db.prepare('INSERT INTO outbid_drafts VALUES(?,?)').run(1,'test-500');
  return db;
}

test('removes only three owner-identified live test bids, clears their notices and number', () => {
  const db=fixture();
  try {
    expect(removeKnownOpeningTestBids(db)).toBe(3);
    const remaining=db.prepare('SELECT message_id AS id FROM monitored_bids ORDER BY id').all() as Array<{id:string}>;
    expect(remaining.map(x=>x.id)).toEqual(['real-120','real-600']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM auction_bidders').get() as {n:number}).n).toBe(1);
    expect((db.prepare('SELECT public_number AS n FROM auction_bidders').get() as {n:number}).n).toBe(868);
    expect((db.prepare('SELECT COUNT(*) AS n FROM auction_notices').get() as {n:number}).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM outbid_drafts').get() as {n:number}).n).toBe(0);
    for(const a of [410,420,500]) expect(isDeletedAuctionTestMessage(db,'test-'+a)).toBe(true);
    expect(isDeletedAuctionTestMessage(db,'real-600')).toBe(false);
    expect(removeKnownOpeningTestBids(db)).toBe(0);
  } finally { db.close(); }
});

test('refuses ambiguous or incomplete sets rather than deleting other bids', () => {
  const db=fixture();
  try {
    db.prepare("DELETE FROM monitored_bids WHERE message_id='test-420'").run();
    expect(removeKnownOpeningTestBids(db)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM monitored_bids').get() as {n:number}).n).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS n FROM auction_bidders').get() as {n:number}).n).toBe(2);
  } finally { db.close(); }
});
