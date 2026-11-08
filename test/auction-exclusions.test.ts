import { expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { isExcludedAuctionSender, resetAuctionExcludingClairie } from '../src/services/auction-exclusions.js';

function dbFixture() {
  const db = new Database(':memory:');
  db.exec([
    'CREATE TABLE monitored_bids(message_id TEXT PRIMARY KEY,chat_id TEXT,lot TEXT,amount INTEGER,received_at INTEGER,mode TEXT,verdict TEXT)',
    'CREATE TABLE auction_bidders(id INTEGER PRIMARY KEY,chat_id TEXT UNIQUE,public_number INTEGER)',
    'CREATE TABLE auction_notices(id INTEGER PRIMARY KEY,source_message_id TEXT,chat_id TEXT,state TEXT)',
    'CREATE TABLE outbid_drafts(id INTEGER PRIMARY KEY,replaced_by TEXT,chat_id TEXT)',
    'CREATE TABLE monitor_state(key TEXT PRIMARY KEY,value TEXT)',
  ].join(';')+';');
  return db;
}

test('reset lot 01 to its unchanged S$410 floor when all accepted bids came from the excluded test account', () => {
  const db=dbFixture();
  try {
    const put=db.prepare('INSERT INTO monitored_bids VALUES(?,?,?,?,?,?,?)');
    put.run('t410','6588747000@s.whatsapp.net','01',410,1,'live','accepted');
    put.run('t420','106154445287506@lid','01',420,2,'live','accepted');
    put.run('t500','6588747000@s.whatsapp.net','01',500,3,'live','accepted');
    db.prepare('INSERT INTO auction_bidders VALUES(?,?,?)').run(1,'6588747000@s.whatsapp.net',827);
    db.prepare('INSERT INTO auction_notices VALUES(?,?,?,?)').run(1,'t500','6588747000@s.whatsapp.net','pending');
    db.prepare('INSERT INTO outbid_drafts VALUES(?,?,?)').run(1,'t500','6588747000@s.whatsapp.net');
    const result=resetAuctionExcludingClairie(db,410);
    expect(result).toMatchObject({removedBids:3,removedLots:['01'],lot01ActiveBids:0,lot01LeadingBid:null,lot01OpeningBid:410});
    expect((db.prepare('SELECT COUNT(*) AS count FROM monitored_bids').get() as {count:number}).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM auction_bidders').get() as {count:number}).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM auction_notices').get() as {count:number}).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM outbid_drafts').get() as {count:number}).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM ignored_auction_test_messages').get() as {count:number}).count).toBe(3);
    expect(resetAuctionExcludingClairie(db,410)).toMatchObject({removedBids:0,lot01ActiveBids:0,lot01LeadingBid:null});
  } finally { db.close(); }
});

test('preserve genuine other bidders and promote highest real offer when clearing test leading bids', () => {
  const db=dbFixture();
  try {
    const put=db.prepare('INSERT INTO monitored_bids VALUES(?,?,?,?,?,?,?)');
    put.run('t500','6588747000@s.whatsapp.net','01',500,1,'live','accepted');
    put.run('real440','6598765432@s.whatsapp.net','01',440,2,'live','registered_not_leading');
    put.run('real420','6598765433@s.whatsapp.net','01',420,3,'live','registered_not_leading');
    put.run('realOther','6598765433@s.whatsapp.net','02',1020,4,'live','accepted');
    db.prepare('INSERT INTO auction_bidders VALUES(?,?,?)').run(1,'6588747000@s.whatsapp.net',827);
    db.prepare('INSERT INTO auction_bidders VALUES(?,?,?)').run(2,'6598765432@s.whatsapp.net',854);
    db.prepare('INSERT INTO auction_bidders VALUES(?,?,?)').run(3,'6598765433@s.whatsapp.net',861);
    db.prepare('INSERT INTO auction_notices VALUES(?,?,?,?)').run(1,'t500','6588747000@s.whatsapp.net','sent');
    db.prepare('INSERT INTO auction_notices VALUES(?,?,?,?)').run(2,'real440','6598765432@s.whatsapp.net','sent');
    const result=resetAuctionExcludingClairie(db,410);
    expect(result).toMatchObject({removedBids:1,lot01ActiveBids:2,lot01LeadingBid:440});
    const real=db.prepare("SELECT message_id AS id,verdict FROM monitored_bids ORDER BY message_id").all();
    expect(real).toEqual([
      {id:'real420',verdict:'registered_not_leading'},
      {id:'real440',verdict:'accepted'},
      {id:'realOther',verdict:'accepted'},
    ]);
    expect((db.prepare('SELECT COUNT(*) AS count FROM auction_bidders').get() as {count:number}).count).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS count FROM auction_notices').get() as {count:number}).count).toBe(1);
  } finally { db.close(); }
});

test('exclude both verified WhatsApp sender IDs, never a name or editable phone field', () => {
  expect(isExcludedAuctionSender('6588747000@s.whatsapp.net')).toBe(true);
  expect(isExcludedAuctionSender('106154445287506@lid')).toBe(true);
  expect(isExcludedAuctionSender('6598765432@s.whatsapp.net')).toBe(false);
  expect(isExcludedAuctionSender('Clairie Seet')).toBe(false);
  expect(isExcludedAuctionSender(null)).toBe(false);
});
