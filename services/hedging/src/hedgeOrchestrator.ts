import Decimal from "decimal.js";

export interface HedgeState {
  bufferTargetPct: Decimal;
  hysteresisPct: Decimal;
  lastHedgeAt?: number;
}

export interface HedgeDecision {
  action: "increase" | "decrease" | "hold";
  reason: string;
}

export function decideHedgeAction(
  bufferPct: Decimal,
  state: HedgeState
): HedgeDecision {
  if (bufferPct.lt(state.bufferTargetPct)) {
    return { action: "increase", reason: "buffer_below_target" };
  }
  if (bufferPct.gt(state.bufferTargetPct.plus(state.hysteresisPct))) {
    return { action: "decrease", reason: "buffer_above_target" };
  }
  return { action: "hold", reason: "buffer_within_band" };
}
