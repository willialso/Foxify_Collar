import Decimal from "decimal.js";

export type HedgeInstrumentType = "option" | "perp" | "spot";

export interface OrderBookSnapshot {
  bid: Decimal | null;
  ask: Decimal | null;
  bidSize: Decimal;
  askSize: Decimal;
  spreadPct: Decimal;
  timestampMs: number | null;
}

export interface VenueQuote {
  venue: string;
  instrument: string;
  type: HedgeInstrumentType;
  book: OrderBookSnapshot;
}

export interface PricingRequest {
  instrument: string;
  type: HedgeInstrumentType;
  side: "buy" | "sell";
  minSize: Decimal;
}

export interface BestPriceResult {
  venue: string;
  instrument: string;
  type: HedgeInstrumentType;
  side: "buy" | "sell";
  price: Decimal;
  size: Decimal;
  spreadPct: Decimal;
  timestampMs: number | null;
}

export interface PricingEngine {
  getBestQuote(request: PricingRequest): Promise<BestPriceResult | null>;
  getQuotes?(request: PricingRequest): Promise<VenueQuote[]>;
}

export interface PredictionSignal {
  volatilityScore: Decimal;
  liquidityScore: Decimal;
  trendScore: Decimal;
}

export interface PredictionEngine {
  getSignals(asset: string): Promise<PredictionSignal>;
}

export interface ExposurePosition {
  asset: string;
  side: "long" | "short";
  entryPrice: Decimal;
  size: Decimal;
  leverage: Decimal;
}

export interface NetExposure {
  asset: string;
  netNotional: Decimal;
  netDelta: Decimal;
}

export interface HedgePlan {
  asset: string;
  type: HedgeInstrumentType;
  targetNotional: Decimal;
  bufferTargetPct: Decimal;
  reason: string;
}

export interface HedgingEngine {
  planHedge(
    exposures: NetExposure[],
    prediction: PredictionSignal
  ): Promise<HedgePlan[]>;
}
