import { expect, test } from 'vitest';
import { MINIMUM_INCREMENT_SGD, validAuctionBidAmount } from '../src/services/auction-pricing.js';

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
