export type PaperFillStatus = "paper_filled" | "paper_rejected";

export function simulateTopOfBookPaperFill(params: {
  side: "buy" | "sell";
  amount: number;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize?: number;
  askSize?: number;
  fillCurrency?: string;
}):
  | {
      status: PaperFillStatus;
      reason: "no_top_of_book" | "insufficient_liquidity";
      fillPrice?: undefined;
      filledAmount?: undefined;
      fillCurrency?: undefined;
      bestBid: number | null;
      bestAsk: number | null;
      availableSize: number;
    }
  | {
      status: PaperFillStatus;
      reason: "partial_fill" | "full_fill";
      fillPrice: number;
      filledAmount: number;
      fillCurrency: string;
      bestBid: number | null;
      bestAsk: number | null;
      availableSize: number;
    } {
  const amount = Number(params.amount);
  const bestBid = params.bestBid ?? null;
  const bestAsk = params.bestAsk ?? null;
  const bidSize = Number(params.bidSize ?? 0);
  const askSize = Number(params.askSize ?? 0);
  const fillPrice = params.side === "buy" ? bestAsk : bestBid;
  const availableSize = params.side === "buy" ? askSize : bidSize;
  const currency = params.fillCurrency ?? "btc";

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      status: "paper_rejected",
      reason: "insufficient_liquidity",
      bestBid,
      bestAsk,
      availableSize: 0
    };
  }
  if (!fillPrice || !Number.isFinite(fillPrice) || fillPrice <= 0) {
    return {
      status: "paper_rejected",
      reason: "no_top_of_book",
      bestBid,
      bestAsk,
      availableSize: Number.isFinite(availableSize) ? availableSize : 0
    };
  }
  if (!Number.isFinite(availableSize) || availableSize <= 0) {
    return {
      status: "paper_rejected",
      reason: "insufficient_liquidity",
      bestBid,
      bestAsk,
      availableSize: 0
    };
  }

  if (availableSize < amount) {
    return {
      status: "paper_filled",
      reason: "partial_fill",
      fillPrice,
      filledAmount: availableSize,
      fillCurrency: currency,
      bestBid,
      bestAsk,
      availableSize
    };
  }

  return {
    status: "paper_filled",
    reason: "full_fill",
    fillPrice,
    filledAmount: amount,
    fillCurrency: currency,
    bestBid,
    bestAsk,
    availableSize
  };
}

export function resolveOptionPremiumUsdc(params: {
  fillPrice: unknown;
  filledAmount: number;
  spotPrice?: number | null;
  isBybitExecution: boolean;
}): number | null {
  const fillPrice = Number(params.fillPrice);
  const filledAmount = Number(params.filledAmount);
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;
  if (!Number.isFinite(filledAmount) || filledAmount <= 0) return null;
  if (params.isBybitExecution) {
    return fillPrice * filledAmount;
  }
  const spotPrice = Number(params.spotPrice ?? 0);
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) return null;
  return fillPrice * spotPrice * filledAmount;
}
