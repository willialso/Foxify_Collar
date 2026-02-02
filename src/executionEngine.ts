import Decimal from "decimal.js";
import { DeribitConnector } from "@foxify/connectors";
import { ExecutionRegistry, VenueOrderRequest } from "./executionRegistry";

export type StrikeCandidate = {
  instrument: string;
  strike: number;
  expiryTag: string;
  tenorDays: number;
  markPrice: number | null;
  askPrice: number | null;
  bidPrice: number | null;
  openInterest: number;
  bidAskSpread: number;
  liquidityScore: number;
};

export type ExecutionAttempt = {
  instrument: string;
  strike: number;
  attemptNumber: number;
  requestedSize: Decimal;
  filledSize: Decimal;
  fillPrice: Decimal | null;
  success: boolean;
  failureReason: string | null;
  timestampMs: number;
  orderId: string | null;
};

export type ExecutionResult = {
  status: "success" | "partial" | "failed" | "perp_fallback";
  totalFilled: Decimal;
  totalCostUsdc: Decimal;
  averageFillPrice: Decimal | null;
  attempts: ExecutionAttempt[];
  finalInstrument: string | null;
  coverageRatio: Decimal;
  executionTimeMs: number;
};

export type ExecutionConfig = {
  maxRetries: number;
  retryDelayMs: number;
  slippageTolerancePct: number;
  minFillRatio: number;
  maxStrikeCandidates: number;
  searchBudgetMs: number;
  minOpenInterest: number;
  maxBidAskSpreadPct: number;
  minMarkPrice: number;
};

const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  maxRetries: 2,
  retryDelayMs: 100,
  slippageTolerancePct: 0.003,
  minFillRatio: 0.5,
  maxStrikeCandidates: 3,
  searchBudgetMs: 1200,
  minOpenInterest: 0.1,
  maxBidAskSpreadPct: 0.05,
  minMarkPrice: 0.0001
};

function calculateBidAskSpread(bid: number | null, ask: number | null): number {
  if (!bid || !ask || bid <= 0 || ask <= 0) return 1.0;
  const mid = (ask + bid) / 2;
  return (ask - bid) / mid;
}

function calculateLiquidityScore(
  strike: number,
  targetStrike: number,
  openInterest: number,
  bidAskSpread: number,
  config: ExecutionConfig
): number {
  const strikeDiff = Math.abs(strike - targetStrike);
  const proximityScore = 1 - Math.min(1, strikeDiff / targetStrike);

  const oiTarget = config.minOpenInterest * 10;
  const oiScore = Math.min(1, openInterest / oiTarget);

  const spreadScore = 1 - Math.min(1, bidAskSpread / config.maxBidAskSpreadPct);

  const liquidityScore = proximityScore * 0.4 + oiScore * 0.3 + spreadScore * 0.3;
  return Math.max(0, Math.min(1, liquidityScore));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function selectStrikeCandidates(
  params: {
    spotPrice: Decimal;
    drawdownFloorPct: Decimal;
    optionType: "put" | "call";
    expiryTag: string;
    targetDays: number;
  },
  connector: DeribitConnector,
  config: ExecutionConfig = DEFAULT_EXECUTION_CONFIG
): Promise<StrikeCandidate[]> {
  const targetStrike =
    params.optionType === "put"
      ? params.spotPrice.times(new Decimal(1).minus(params.drawdownFloorPct))
      : params.spotPrice.times(new Decimal(1).plus(params.drawdownFloorPct));

  const instruments = await connector.listInstruments("BTC");
  const results = (instruments as any)?.result || [];

  const filtered = results.filter((inst: any) => {
    if (inst.option_type !== params.optionType) return false;
    if (!inst.instrument_name?.includes(params.expiryTag)) return false;
    const strike = Number(inst.strike || 0);
    if (params.optionType === "put") {
      return strike >= targetStrike.toNumber();
    }
    return strike <= targetStrike.toNumber();
  });

  const candidates: StrikeCandidate[] = [];

  for (const inst of filtered) {
    const openInterest = Number(inst.open_interest || 0);
    if (openInterest < config.minOpenInterest) continue;

    try {
      const ticker = await connector.getTicker(inst.instrument_name);
      const tickerData = (ticker as any)?.result || {};

      const markPrice = Number(tickerData.mark_price || 0);
      const askPrice = Number(tickerData.best_ask_price || tickerData.ask_price || 0);
      const bidPrice = Number(tickerData.best_bid_price || tickerData.bid_price || 0);

      if (markPrice < config.minMarkPrice) continue;

      const bidAskSpread = calculateBidAskSpread(bidPrice, askPrice);
      if (bidAskSpread > config.maxBidAskSpreadPct) continue;

      const strike = Number(inst.strike);
      const liquidityScore = calculateLiquidityScore(
        strike,
        targetStrike.toNumber(),
        openInterest,
        bidAskSpread,
        config
      );

      const expiryTag = inst.instrument_name.split("-")[1] || params.expiryTag;
      const expiryMs = inst.expiration_timestamp || Date.now();
      const tenorDays = Math.max(1, Math.round((expiryMs - Date.now()) / (24 * 60 * 60 * 1000)));

      candidates.push({
        instrument: inst.instrument_name,
        strike,
        expiryTag,
        tenorDays,
        markPrice,
        askPrice: askPrice > 0 ? askPrice : null,
        bidPrice: bidPrice > 0 ? bidPrice : null,
        openInterest,
        bidAskSpread,
        liquidityScore
      });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => b.liquidityScore - a.liquidityScore);
  return candidates.slice(0, config.maxStrikeCandidates);
}

export async function executeMultiStrikeOption(
  params: {
    candidates: StrikeCandidate[];
    targetSize: Decimal;
    spotPrice: Decimal;
    side: "buy" | "sell";
  },
  executionRegistry: ExecutionRegistry,
  config: ExecutionConfig = DEFAULT_EXECUTION_CONFIG
): Promise<ExecutionResult> {
  const startTime = Date.now();
  let totalFilled = new Decimal(0);
  let totalCost = new Decimal(0);
  const attempts: ExecutionAttempt[] = [];
  let finalInstrument: string | null = null;

  for (const candidate of params.candidates) {
    if (Date.now() - startTime > config.searchBudgetMs) break;
    const remainingSize = params.targetSize.minus(totalFilled);
    if (remainingSize.lte(0)) break;

    const basePrice =
      params.side === "buy"
        ? candidate.askPrice || candidate.markPrice || 0
        : candidate.bidPrice || candidate.markPrice || 0;

    if (!basePrice || basePrice <= 0) {
      attempts.push({
        instrument: candidate.instrument,
        strike: candidate.strike,
        attemptNumber: 0,
        requestedSize: remainingSize,
        filledSize: new Decimal(0),
        fillPrice: null,
        success: false,
        failureReason: "no_price_available",
        timestampMs: Date.now(),
        orderId: null
      });
      console.info("execution.attempt.no_price", {
        instrument: candidate.instrument,
        strike: candidate.strike
      });
      continue;
    }

    let strikeSuccess = false;

    for (let retry = 0; retry <= config.maxRetries; retry++) {
      if (Date.now() - startTime > config.searchBudgetMs) break;
      const slippage =
        params.side === "buy"
          ? 1 + config.slippageTolerancePct
          : 1 - config.slippageTolerancePct;
      const limitPrice = basePrice * slippage;

      try {
        const orderRequest: VenueOrderRequest = {
          instrument: candidate.instrument,
          amount: remainingSize.toNumber(),
          side: params.side,
          type: "limit",
          price: limitPrice
        };

        console.info("execution.attempt.place", {
          instrument: candidate.instrument,
          strike: candidate.strike,
          attemptNumber: retry,
          requestedSize: remainingSize.toNumber(),
          limitPrice
        });

        const response = await executionRegistry.placeOrder("deribit", orderRequest);
        const result = response as any;

        const filledSize = new Decimal(result?.filledAmount || result?.result?.filled_amount || 0);
        const fillPriceRaw =
          result?.result?.average_price || result?.result?.price || result?.fillPrice || basePrice;
        const orderId = result?.result?.order?.order_id || result?.orderId || null;
        const fillPrice = Number.isFinite(fillPriceRaw) ? new Decimal(fillPriceRaw) : null;
        const success = filledSize.gt(0);

        attempts.push({
          instrument: candidate.instrument,
          strike: candidate.strike,
          attemptNumber: retry,
          requestedSize: remainingSize,
          filledSize,
          fillPrice,
          success,
          failureReason: success ? null : "no_fill",
          timestampMs: Date.now(),
          orderId
        });

        console.info("execution.attempt.result", {
          instrument: candidate.instrument,
          strike: candidate.strike,
          attemptNumber: retry,
          filledSize: filledSize.toNumber(),
          success,
          failureReason: success ? null : "no_fill"
        });

        if (success) {
          totalFilled = totalFilled.plus(filledSize);
          const resolvedFillPrice = fillPrice ?? new Decimal(basePrice);
          const fillCost = filledSize.times(resolvedFillPrice).times(params.spotPrice);
          totalCost = totalCost.plus(fillCost);
          finalInstrument = candidate.instrument;
          strikeSuccess = true;
          break;
        }

        if (!success && retry < config.maxRetries) {
          await sleep(config.retryDelayMs);
        }
      } catch (error) {
        attempts.push({
          instrument: candidate.instrument,
          strike: candidate.strike,
          attemptNumber: retry,
          requestedSize: remainingSize,
          filledSize: new Decimal(0),
          fillPrice: null,
          success: false,
          failureReason: String(error),
          timestampMs: Date.now(),
          orderId: null
        });

        console.warn("execution.attempt.error", {
          instrument: candidate.instrument,
          strike: candidate.strike,
          attemptNumber: retry,
          error: String(error)
        });

        if (retry < config.maxRetries) {
          await sleep(config.retryDelayMs);
        }
      }
    }

    if (strikeSuccess) {
      const coverageRatio = totalFilled.div(params.targetSize);
      if (coverageRatio.gte(config.minFillRatio)) {
        break;
      }
    }
  }

  const executionTimeMs = Date.now() - startTime;
  const coverageRatio = totalFilled.div(params.targetSize);

  let status: "success" | "partial" | "failed";
  if (coverageRatio.gte(0.99)) {
    status = "success";
  } else if (coverageRatio.gte(config.minFillRatio)) {
    status = "partial";
  } else {
    status = "failed";
  }

  const averageFillPrice =
    totalFilled.gt(0) && totalCost.gt(0)
      ? totalCost.div(totalFilled).div(params.spotPrice)
      : null;

  return {
    status,
    totalFilled,
    totalCostUsdc: totalCost,
    averageFillPrice,
    attempts,
    finalInstrument,
    coverageRatio,
    executionTimeMs
  };
}

export async function executePerpFallback(
  params: {
    targetSize: Decimal;
    spotPrice: Decimal;
    side: "buy" | "sell";
  },
  executionRegistry: ExecutionRegistry,
  config: ExecutionConfig = DEFAULT_EXECUTION_CONFIG
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const instrument = "BTC-PERPETUAL";
  const attempts: ExecutionAttempt[] = [];

  try {
    const orderRequest: VenueOrderRequest = {
      instrument,
      amount: params.targetSize.toNumber(),
      side: params.side,
      type: "market"
    };

    console.info("execution.perp.place", {
      instrument,
      requestedSize: params.targetSize.toNumber(),
      side: params.side
    });

    const response = await executionRegistry.placeOrder("deribit", orderRequest);
    const result = response as any;

    const filledSize = new Decimal(
      result?.filledAmount || result?.result?.filled_amount || params.targetSize
    );
    const fillPriceRaw = result?.result?.average_price || result?.result?.price;
    const fillPrice = Number.isFinite(fillPriceRaw)
      ? new Decimal(fillPriceRaw)
      : params.spotPrice;
    const orderId = result?.result?.order?.order_id || result?.orderId || null;

    attempts.push({
      instrument,
      strike: 0,
      attemptNumber: 0,
      requestedSize: params.targetSize,
      filledSize,
      fillPrice,
      success: true,
      failureReason: null,
      timestampMs: Date.now(),
      orderId
    });

    console.info("execution.perp.result", {
      instrument,
      filledSize: filledSize.toNumber()
    });

    const totalCost = filledSize.times(fillPrice);
    const coverageRatio = filledSize.div(params.targetSize);

    return {
      status: "perp_fallback",
      totalFilled: filledSize,
      totalCostUsdc: totalCost,
      averageFillPrice: fillPrice,
      attempts,
      finalInstrument: instrument,
      coverageRatio,
      executionTimeMs: Date.now() - startTime
    };
  } catch (error) {
    attempts.push({
      instrument,
      strike: 0,
      attemptNumber: 0,
      requestedSize: params.targetSize,
      filledSize: new Decimal(0),
      fillPrice: null,
      success: false,
      failureReason: String(error),
      timestampMs: Date.now(),
      orderId: null
    });

    console.warn("execution.perp.error", {
      instrument,
      error: String(error)
    });

    return {
      status: "failed",
      totalFilled: new Decimal(0),
      totalCostUsdc: new Decimal(0),
      averageFillPrice: null,
      attempts,
      finalInstrument: null,
      coverageRatio: new Decimal(0),
      executionTimeMs: Date.now() - startTime
    };
  }
}

export async function buildExecutionPlan(
  params: {
    spotPrice: Decimal;
    drawdownFloorPct: Decimal;
    targetSize: Decimal;
    optionType: "put" | "call";
    expiryTag: string;
    targetDays: number;
    allowPerpFallback: boolean;
  },
  connector: DeribitConnector,
  executionRegistry: ExecutionRegistry,
  config: ExecutionConfig = DEFAULT_EXECUTION_CONFIG
): Promise<ExecutionResult> {
  const startTime = Date.now();

  const candidates = await selectStrikeCandidates(
    {
      spotPrice: params.spotPrice,
      drawdownFloorPct: params.drawdownFloorPct,
      optionType: params.optionType,
      expiryTag: params.expiryTag,
      targetDays: params.targetDays
    },
    connector,
    config
  );

  if (Date.now() - startTime > config.searchBudgetMs) {
    return {
      status: "failed",
      totalFilled: new Decimal(0),
      totalCostUsdc: new Decimal(0),
      averageFillPrice: null,
      attempts: [],
      finalInstrument: null,
      coverageRatio: new Decimal(0),
      executionTimeMs: Date.now() - startTime
    };
  }

  if (candidates.length === 0) {
    if (params.allowPerpFallback) {
      const side = params.optionType === "put" ? "buy" : "sell";
      return await executePerpFallback(
        {
          targetSize: params.targetSize,
          spotPrice: params.spotPrice,
          side
        },
        executionRegistry,
        config
      );
    }
    return {
      status: "failed",
      totalFilled: new Decimal(0),
      totalCostUsdc: new Decimal(0),
      averageFillPrice: null,
      attempts: [],
      finalInstrument: null,
      coverageRatio: new Decimal(0),
      executionTimeMs: Date.now() - startTime
    };
  }

  const side = params.optionType === "put" ? "buy" : "sell";
  const optionResult = await executeMultiStrikeOption(
    {
      candidates,
      targetSize: params.targetSize,
      spotPrice: params.spotPrice,
      side
    },
    executionRegistry,
    config
  );

  if (optionResult.status === "success" || optionResult.status === "partial") {
    return optionResult;
  }

  if (params.allowPerpFallback) {
    const perpResult = await executePerpFallback(
      {
        targetSize: params.targetSize,
        spotPrice: params.spotPrice,
        side
      },
      executionRegistry,
      config
    );

    perpResult.attempts = [...optionResult.attempts, ...perpResult.attempts];
    perpResult.executionTimeMs = Date.now() - startTime;
    return perpResult;
  }

  return optionResult;
}
