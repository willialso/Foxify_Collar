import { DeribitConnector, DeribitOrderRequest } from "@foxify/connectors";
import { getBybitOrderbook, parseBybitExpiryTag } from "./bybitAdapter";
import { simulateTopOfBookPaperFill } from "./executionUtils";

export type VenueOrderRequest = DeribitOrderRequest & { spotPrice?: number };

export interface VenueExecutor {
  venue: string;
  placeOrder(request: VenueOrderRequest): Promise<unknown>;
}

export class ExecutionRegistry {
  private executors = new Map<string, VenueExecutor>();

  register(executor: VenueExecutor): void {
    this.executors.set(executor.venue, executor);
  }

  async placeOrder(venue: string, request: VenueOrderRequest): Promise<unknown> {
    const executor = this.executors.get(venue);
    if (!executor) {
      throw new Error(`Missing executor for venue: ${venue}`);
    }
    return executor.placeOrder(request);
  }
}

export function createDeribitExecutor(connector: DeribitConnector): VenueExecutor {
  return {
    venue: "deribit",
    placeOrder: (request) => connector.placeOrder(request)
  };
}

export function createBybitExecutor(): VenueExecutor {
  return {
    venue: "bybit",
    placeOrder: async (request) => {
      const instrument = String(request.instrument || "");
      const parts = instrument.split("-");
      if (parts.length < 4) {
        throw new Error(`Invalid Bybit instrument: ${instrument}`);
      }
      const asset = parts[0];
      const expiryTag = parts[1];
      const strike = Number(parts[2]);
      const optionType = parts[3]?.toUpperCase() as "C" | "P";
      const expiryDate = parseBybitExpiryTag(expiryTag);
      if (!expiryDate || !Number.isFinite(strike) || strike <= 0 || (optionType !== "C" && optionType !== "P")) {
        throw new Error(`Invalid Bybit instrument: ${instrument}`);
      }
      const book = await getBybitOrderbook(asset, strike, expiryDate, optionType);
      if (!book) {
        throw new Error(`Bybit orderbook unavailable: ${instrument}`);
      }
      const side = request.side === "sell" ? "sell" : "buy";
      const simulated = simulateTopOfBookPaperFill({
        side,
        amount: Number(request.amount ?? 0),
        bestBid: Number.isFinite(book.bid) ? book.bid : null,
        bestAsk: Number.isFinite(book.ask) ? book.ask : null,
        bidSize: Number.isFinite(book.bidSize) ? book.bidSize : 0,
        askSize: Number.isFinite(book.askSize) ? book.askSize : 0,
        fillCurrency: "usdt"
      });
      return {
        status: simulated.status,
        reason: simulated.reason,
        filledAmount: simulated.filledAmount ?? 0,
        fillPrice: simulated.fillPrice ?? null,
        fillCurrency: simulated.fillCurrency ?? "usdt",
        bestBid: simulated.bestBid,
        bestAsk: simulated.bestAsk,
        availableSize: simulated.availableSize
      };
    }
  };
}
