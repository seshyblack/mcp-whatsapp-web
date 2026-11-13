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

test('WhatsApp auction opening bids match the published approved 9 Nov values for all 34 lots', () => {
  // Snapshot of the published website approvedOpeningBids. Update both together.
  expect(OPENINGS).toEqual({
    '01': 400,
    '02': 950,
    '03': 1010,
    '04': 430,
    '05': 130,
    '06': 350,
    '07': 830,
    '08': 210,
    '09': 80,
    '10': 310,
    '11': 220,
    '12': 210,
    '13': 140,
    '14': 130,
    '15': 230,
    '16': 270,
    '17': 320,
    '18': 100,
    '19': 210,
    '20': 150,
    '21': 250,
    '22': 80,
    '23': 90,
    '24': 80,
    '25': 170,
    '26': 90,
    '27': 60,
    '28': 140,
    '29': 110,
    '30': 130,
    '31': 170,
    '32': 130,
    '33': 400,
    '34': 220,
  });
});

test('Lot 34 valid website bid and follow-up are parsed without admitting nonexistent Lot 35', () => {
  expect(parseAuctionForm(websiteBid('34', 220))).toMatchObject({lot:'34',amount:220,consent:true});
  expect(parseAuctionFollowUp('Bid Lot 34: S$240')).toMatchObject({lot:'34',amount:240,followUp:true});
  expect(validAuctionBidAmount(OPENINGS['34'],230)).toBe(true);
  expect(validAuctionBidAmount(OPENINGS['34'],240)).toBe(true);
  expect(validAuctionBidAmount(OPENINGS['34'],220)).toBe(true);
  expect(validAuctionBidAmount(OPENINGS['34'],225)).toBe(false);
  expect(parseAuctionFollowUp('Bid Lot 35: S$160')).toBeNull();
  expect(parseAuctionForm(websiteBid('35',220))?.lot).not.toBe('35');
  expect(parseAuctionForm(websiteBid('34',220).replace('CALMISTRY — PRIVATE COLLECTION AUCTION','CALMISTRY AUCTION — TEST MESSAGE (NOT A BID)'))).toBeNull();
});

test('screen divider opening bids are protected at the new minimums', () => {
  for (const [lot, opening] of [['01', 400], ['04', 430], ['33', 400]] as const) {
    expect(OPENINGS[lot]).toBe(opening);
    expect(validAuctionBidAmount(OPENINGS[lot], opening)).toBe(true);
    expect(validAuctionBidAmount(OPENINGS[lot], opening + 10)).toBe(true);
    expect(validAuctionBidAmount(OPENINGS[lot], opening - 10)).toBe(false);
    expect(validAuctionBidAmount(OPENINGS[lot], opening + 5)).toBe(false);
    expect(parseAuctionForm(websiteBid(lot, opening))).toMatchObject({ lot, amount: opening, consent: true });
  }
});
