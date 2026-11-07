import { expect, test } from 'vitest';
import { MINIMUM_INCREMENT_SGD, validAuctionBidAmount } from '../src/services/auction-pricing.js';
import { OPENINGS, parseAuctionForm, parseAuctionFollowUp } from '../src/services/auction-monitor.js';

test('auction offers are placed in S$10 increments from each approved opening bid', () => {
  expect(MINIMUM_INCREMENT_SGD).toBe(10);
  for (const price of [210,220,230,250,260,320]) {
    expect(validAuctionBidAmount(210,price)).toBe(true);
  }
  for (const price of [0,200,209,215,219,225,251,320.50]) {
    expect(validAuctionBidAmount(210,price)).toBe(false);
  }
  expect(validAuctionBidAmount(870,870)).toBe(true);
  expect(validAuctionBidAmount(870,880)).toBe(true);
  expect(validAuctionBidAmount(870,875)).toBe(false);
  expect(validAuctionBidAmount(50,60)).toBe(true);
  expect(validAuctionBidAmount(undefined,100)).toBe(false);
});


function websiteBid(lot: string, amount: number): string {
  return [
    'CALMISTRY — PRIVATE COLLECTION AUCTION',
    'Lot ' + lot + ' — Avami Leaf Pendant',
    'Bid: SGD ' + amount + ' (S$' + amount + ')',
    '',
    'Full name: Test Buyer',
    'WhatsApp: +6599999999',
    '',
    'Delivery address:',
    '10 Test Street, Singapore 123456',
    '',
    'Bidding terms: read and agreed.',
    'Payment and collection deadlines: understood and agreed.',
    'Data consent: agreed.',
  ].join('\n');
}

test('WhatsApp auction and website use identical opening bids for all 34 lots', () => {
  expect(OPENINGS).toEqual({
  "10": 410,
  "11": 190,
  "12": 230,
  "13": 90,
  "14": 80,
  "15": 270,
  "16": 290,
  "17": 330,
  "18": 120,
  "19": 140,
  "20": 130,
  "21": 240,
  "22": 90,
  "23": 80,
  "24": 70,
  "25": 160,
  "26": 80,
  "27": 50,
  "28": 120,
  "29": 100,
  "30": 140,
  "31": 170,
  "32": 140,
  "33": 390,
  "34": 230,
  "01": 410,
  "02": 1020,
  "03": 1040,
  "04": 350,
  "05": 140,
  "06": 360,
  "07": 760,
  "08": 190,
  "09": 70
});
});

test('Lot 34 valid website bid and follow-up are parsed without admitting nonexistent Lot 35', () => {
  expect(parseAuctionForm(websiteBid('34', 230))).toMatchObject({lot:'34',amount:230,consent:true});
  expect(parseAuctionFollowUp('Bid Lot 34: S$240')).toMatchObject({lot:'34',amount:240,followUp:true});
  expect(validAuctionBidAmount(OPENINGS['34'],230)).toBe(true);
  expect(validAuctionBidAmount(OPENINGS['34'],240)).toBe(true);
  expect(validAuctionBidAmount(OPENINGS['34'],220)).toBe(false);
  expect(validAuctionBidAmount(OPENINGS['34'],235)).toBe(false);
  expect(parseAuctionFollowUp('Bid Lot 35: S$160')).toBeNull();
  expect(parseAuctionForm(websiteBid('35',230))?.lot).not.toBe('35');
  expect(parseAuctionForm(websiteBid('34',230).replace('CALMISTRY — PRIVATE COLLECTION AUCTION','CALMISTRY AUCTION — TEST MESSAGE (NOT A BID)'))).toBeNull();
});

test('screen divider opening bids are protected at the new minimums', () => {
  for (const [lot, opening] of [['01', 410], ['04', 350], ['33', 390]] as const) {
    expect(OPENINGS[lot]).toBe(opening);
    expect(validAuctionBidAmount(OPENINGS[lot], opening)).toBe(true);
    expect(validAuctionBidAmount(OPENINGS[lot], opening + 10)).toBe(true);
    expect(validAuctionBidAmount(OPENINGS[lot], opening - 10)).toBe(false);
    expect(validAuctionBidAmount(OPENINGS[lot], opening + 5)).toBe(false);
    expect(parseAuctionForm(websiteBid(lot, opening))).toMatchObject({ lot, amount: opening, consent: true });
  }
});
