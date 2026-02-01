import Decimal from "decimal.js";
import { decideHedgeAction, HedgeState } from "./hedgeOrchestrator";
import { shouldRenew } from "./renewal";

export interface RollInputs {
  bufferPct: Decimal;
  hedgeState: HedgeState;
  expiryIso: string;
  renewWindowMinutes: number;
  positionSide?: "long" | "short";
  currentOptionType?: "put" | "call";
  hedgeType?: "option" | "perp";
}

export interface RollDecision {
  hedgeAction: "increase" | "decrease" | "hold";
  renew: boolean;
  reason: string;
  recommendedSide: "buy" | "sell";
  perpFallbackSide: "buy" | "sell";
}

export function evaluateRollingHedge(inputs: RollInputs): RollDecision {
  const hedgeDecision = decideHedgeAction(inputs.bufferPct, inputs.hedgeState);
  const renew = shouldRenew(new Date(), {
    expiryIso: inputs.expiryIso,
    renewWindowMinutes: inputs.renewWindowMinutes
  });

  const isLongPosition = inputs.positionSide === "long";
  const optionSide: "buy" = "buy";
  const perpSide: "buy" | "sell" = isLongPosition ? "sell" : "buy";
  const recommendedSide = inputs.hedgeType === "perp" ? perpSide : optionSide;

  return {
    hedgeAction: hedgeDecision.action,
    renew,
    reason: renew ? "renew_window" : hedgeDecision.reason,
    recommendedSide,
    perpFallbackSide: perpSide
  };
}
