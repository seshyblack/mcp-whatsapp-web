/** One offer equals the exact amount the bidder submits (no proxy bidding). */
export const MINIMUM_INCREMENT_SGD = 10;

/** Opening bid itself is valid; subsequent bids must follow the S$10 grid. */
export function validAuctionBidAmount(opening: number | undefined, amount: number): boolean {
  return Number.isSafeInteger(opening) && (opening ?? 0) > 0 &&
    Number.isSafeInteger(amount) && amount >= (opening as number) &&
    (amount - (opening as number)) % MINIMUM_INCREMENT_SGD === 0;
}
