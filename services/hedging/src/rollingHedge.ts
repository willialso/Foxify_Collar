import Decimal from "decimal.js";
import { decideHedgeAction, HedgeState } from "./hedgeOrchestrator";
import { shouldRenew } from "./renewal";

export interface RollInputs {
  bufferPct: Decimal;
  hedgeState: HedgeState;
  expiryIso: string;
  renewWindowMinutes: number;
}

export interface RollDecision {
  hedgeAction: "increase" | "decrease" | "hold";
  renew: boolean;
  reason: string;
}

export function evaluateRollingHedge(inputs: RollInputs): RollDecision {
  const hedgeDecision = decideHedgeAction(inputs.bufferPct, inputs.hedgeState);
  const renew = shouldRenew(new Date(), {
    expiryIso: inputs.expiryIso,
    renewWindowMinutes: inputs.renewWindowMinutes
  });

  return {
    hedgeAction: hedgeDecision.action,
    renew,
    reason: renew ? "renew_window" : hedgeDecision.reason
  };
}
