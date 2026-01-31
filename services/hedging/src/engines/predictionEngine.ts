import Decimal from "decimal.js";
import { PredictionEngine, PredictionSignal } from "./types";

export class NeutralPredictionEngine implements PredictionEngine {
  async getSignals(): Promise<PredictionSignal> {
    return {
      volatilityScore: new Decimal(0.5),
      liquidityScore: new Decimal(0.5),
      trendScore: new Decimal(0)
    };
  }
}

export class VolatilityPredictionEngine implements PredictionEngine {
  constructor(
    private getVolatilityScore: (asset: string) => Promise<Decimal>,
    private fallbackScore = new Decimal(0.5)
  ) {}

  async getSignals(asset: string): Promise<PredictionSignal> {
    try {
      const score = await this.getVolatilityScore(asset);
      const clamped = Decimal.max(new Decimal(0), Decimal.min(score, new Decimal(1)));
      return {
        volatilityScore: clamped,
        liquidityScore: new Decimal(0.5),
        trendScore: new Decimal(0)
      };
    } catch {
      return {
        volatilityScore: this.fallbackScore,
        liquidityScore: new Decimal(0.5),
        trendScore: new Decimal(0)
      };
    }
  }
}
