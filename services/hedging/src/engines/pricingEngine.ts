import Decimal from "decimal.js";
import { BestPriceResult, PricingEngine, PricingRequest, VenueQuote } from "./types";

export interface PriceVenue {
  name: string;
  getQuote(request: PricingRequest): Promise<VenueQuote | null>;
}

export class MultiVenuePricingEngine implements PricingEngine {
  constructor(private venues: PriceVenue[]) {}

  async getBestQuote(request: PricingRequest): Promise<BestPriceResult | null> {
    const usable = await this.getQuotes(request);
    if (!usable.length) return null;

    const best = usable.reduce((acc, quote) => {
      if (!quote.book.ask || !quote.book.bid) return acc;
      const price = request.side === "buy" ? quote.book.ask : quote.book.bid;
      if (!price || quote.book.askSize.lt(request.minSize) || quote.book.bidSize.lt(request.minSize)) {
        return acc;
      }
      if (!acc) return { quote, price };
      if (request.side === "buy" ? price.lt(acc.price) : price.gt(acc.price)) {
        return { quote, price };
      }
      return acc;
    }, null as { quote: VenueQuote; price: Decimal } | null);

    if (!best) return null;

    return {
      venue: best.quote.venue,
      instrument: best.quote.instrument,
      type: best.quote.type,
      side: request.side,
      price: best.price,
      size: request.minSize,
      spreadPct: best.quote.book.spreadPct,
      timestampMs: best.quote.book.timestampMs
    };
  }

  async getQuotes(request: PricingRequest): Promise<VenueQuote[]> {
    const quotes = await Promise.all(this.venues.map((venue) => venue.getQuote(request)));
    return quotes.filter(Boolean) as VenueQuote[];
  }
}
