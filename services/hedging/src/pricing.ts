import Decimal from "decimal.js";

export interface OrderBook {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export interface FreshnessResult {
  isFresh: boolean;
  lastChangeTimestamp: number | null;
}

export interface DepthFillResult {
  avgPrice: Decimal | null;
  worstPrice: Decimal | null;
  filledSize: Decimal;
}

export function bestBidAsk(book: OrderBook): { bid: number | null; ask: number | null } {
  const bid = book.bids?.[0]?.[0] ?? null;
  const ask = book.asks?.[0]?.[0] ?? null;
  return { bid, ask };
}

export function midFromOrderBook(book: OrderBook): Decimal | null {
  const { bid: bestBid, ask: bestAsk } = bestBidAsk(book);
  if (!bestBid || !bestAsk) return null;
  return new Decimal(bestBid).plus(bestAsk).div(2);
}

export function clampMidToSpread(mid: Decimal, bestBid: number, bestAsk: number): Decimal {
  const min = new Decimal(bestBid);
  const max = new Decimal(bestAsk);
  if (mid.lessThan(min)) return min;
  if (mid.greaterThan(max)) return max;
  return mid;
}

export function spreadPct(bestBid: number, bestAsk: number): Decimal {
  if (!bestBid || !bestAsk) return new Decimal(1);
  return new Decimal(bestAsk).minus(bestBid).div(new Decimal(bestAsk));
}

export function estimateAverageFill(
  book: OrderBook,
  side: "buy" | "sell",
  size: Decimal
): DepthFillResult {
  if (size.lte(0)) {
    return { avgPrice: null, worstPrice: null, filledSize: new Decimal(0) };
  }
  const levels = side === "buy" ? book.asks : book.bids;
  if (!levels || levels.length === 0) {
    return { avgPrice: null, worstPrice: null, filledSize: new Decimal(0) };
  }
  let remaining = size;
  let cost = new Decimal(0);
  let worstPrice: Decimal | null = null;
  for (const [priceRaw, sizeRaw] of levels) {
    if (remaining.lte(0)) break;
    const levelSize = new Decimal(sizeRaw || 0);
    if (levelSize.lte(0)) continue;
    const fillSize = Decimal.min(levelSize, remaining);
    const price = new Decimal(priceRaw);
    cost = cost.add(price.mul(fillSize));
    worstPrice = price;
    remaining = remaining.minus(fillSize);
  }
  const filledSize = size.minus(remaining);
  if (filledSize.lte(0)) {
    return { avgPrice: null, worstPrice: null, filledSize: new Decimal(0) };
  }
  const avgPrice = cost.div(filledSize);
  return { avgPrice, worstPrice, filledSize };
}

export function isFreshPrice(lastChangeTimestamp: number | undefined, maxAgeMs: number): FreshnessResult {
  if (!lastChangeTimestamp) {
    return { isFresh: false, lastChangeTimestamp: null };
  }
  const ageMs = Date.now() - lastChangeTimestamp;
  return { isFresh: ageMs <= maxAgeMs, lastChangeTimestamp };
}
