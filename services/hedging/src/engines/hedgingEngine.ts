import Decimal from "decimal.js";
import { HedgingEngine, HedgePlan, NetExposure, PredictionSignal } from "./types";

export class RollingNetHedgingEngine implements HedgingEngine {
  async planHedge(
    exposures: NetExposure[],
    prediction: PredictionSignal
  ): Promise<HedgePlan[]> {
    const plans: HedgePlan[] = [];
    for (const exposure of exposures) {
      if (exposure.netNotional.eq(0)) continue;
      const bufferTargetPct = new Decimal(0.03).plus(prediction.volatilityScore.mul(0.02));
      plans.push({
        asset: exposure.asset,
        type: "option",
        targetNotional: exposure.netNotional,
        bufferTargetPct,
        reason: "net_exposure_hedge"
      });
    }
    return plans;
  }
}
