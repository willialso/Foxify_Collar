import Decimal from "decimal.js";

type RiskControlsLike = {
  ctc_enabled?: boolean;
  ctc_shadow_mode?: boolean;
};

export function resolveLiveCtcFeeControl(riskControls: RiskControlsLike): boolean {
  return riskControls.ctc_enabled === true && riskControls.ctc_shadow_mode === false;
}

export function isQuoteAmountWithinTolerance(params: {
  quotedSize?: Decimal | null;
  requestedSize: Decimal;
  tolerancePct?: number;
  toleranceAbs?: number;
}): { ok: boolean; maxAllowed: Decimal | null } {
  if (!params.quotedSize || !params.quotedSize.isFinite() || params.quotedSize.lte(0)) {
    return { ok: true, maxAllowed: null };
  }
  if (!params.requestedSize.isFinite() || params.requestedSize.lte(0)) {
    return { ok: false, maxAllowed: params.quotedSize };
  }
  const pctRaw = Number(params.tolerancePct ?? 0.02);
  const absRaw = Number(params.toleranceAbs ?? 0.001);
  const pct = Number.isFinite(pctRaw) && pctRaw >= 0 ? new Decimal(pctRaw) : new Decimal(0.02);
  const abs = Number.isFinite(absRaw) && absRaw >= 0 ? new Decimal(absRaw) : new Decimal(0.001);
  const maxAllowed = params.quotedSize.mul(new Decimal(1).add(pct)).add(abs);
  return { ok: params.requestedSize.lte(maxAllowed), maxAllowed };
}

export function isSurvivalSatisfied(
  survivalCheck: { pass?: boolean | null } | null | undefined
): boolean {
  return survivalCheck?.pass === true;
}
