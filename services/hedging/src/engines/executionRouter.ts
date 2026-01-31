import Decimal from "decimal.js";
import { BestPriceResult } from "./types";

export interface ExecutionPlan {
  venue: string;
  instrument: string;
  side: "buy" | "sell";
  size: Decimal;
  price: Decimal;
  spreadPct: Decimal;
  timestampMs: number | null;
}

export interface ExecutionRouter {
  route(quotes: BestPriceResult[], requiredSize: Decimal): ExecutionPlan[];
}

export class SingleVenueRouter implements ExecutionRouter {
  route(quotes: BestPriceResult[], requiredSize: Decimal): ExecutionPlan[] {
    if (quotes.length === 0 || requiredSize.lte(0)) return [];
    const best = quotes[0];
    return [
      {
        venue: best.venue,
        instrument: best.instrument,
        side: best.side,
        size: Decimal.min(best.size, requiredSize),
        price: best.price,
        spreadPct: best.spreadPct,
        timestampMs: best.timestampMs
      }
    ];
  }
}

export class BestPriceSplitRouter implements ExecutionRouter {
  constructor(private maxVenues = 3) {}

  route(quotes: BestPriceResult[], requiredSize: Decimal): ExecutionPlan[] {
    if (quotes.length === 0 || requiredSize.lte(0)) return [];
    const side = quotes[0].side;
    const sorted = quotes
      .slice()
      .sort((a, b) => {
        if (side === "buy") return a.price.comparedTo(b.price);
        return b.price.comparedTo(a.price);
      })
      .slice(0, this.maxVenues);

    let remaining = requiredSize;
    const plans: ExecutionPlan[] = [];
    for (const quote of sorted) {
      if (remaining.lte(0)) break;
      const fillSize = Decimal.min(quote.size, remaining);
      if (fillSize.lte(0)) continue;
      plans.push({
        venue: quote.venue,
        instrument: quote.instrument,
        side: quote.side,
        size: fillSize,
        price: quote.price,
        spreadPct: quote.spreadPct,
        timestampMs: quote.timestampMs
      });
      remaining = remaining.minus(fillSize);
    }
    return plans;
  }
}
