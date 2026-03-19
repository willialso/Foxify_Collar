import Decimal from "decimal.js";

export type ProtectionType = "long" | "short";

type TierDefaults = {
  drawdownFloorPct: number;
  expiryDays: number;
  renewWindowMinutes: number;
};

export const PILOT_TIER_DEFAULTS: Record<string, TierDefaults> = {
  "Pro (Bronze)": {
    drawdownFloorPct: 0.2,
    expiryDays: 7,
    renewWindowMinutes: 1440
  },
  "Pro (Silver)": {
    drawdownFloorPct: 0.15,
    expiryDays: 7,
    renewWindowMinutes: 1440
  },
  "Pro (Gold)": {
    drawdownFloorPct: 0.12,
    expiryDays: 7,
    renewWindowMinutes: 1440
  },
  "Pro (Platinum)": {
    drawdownFloorPct: 0.12,
    expiryDays: 7,
    renewWindowMinutes: 1440
  }
};

export const normalizeTierName = (tierName?: string): string => {
  if (!tierName) return "Pro (Bronze)";
  return PILOT_TIER_DEFAULTS[tierName] ? tierName : "Pro (Bronze)";
};

export const resolveDrawdownFloorPct = (params: {
  tierName?: string;
  drawdownFloorPct?: number;
}): Decimal => {
  const tierName = normalizeTierName(params.tierName);
  const fallback = PILOT_TIER_DEFAULTS[tierName].drawdownFloorPct;
  const candidate = Number(params.drawdownFloorPct);
  if (Number.isFinite(candidate) && candidate > 0 && candidate < 1) {
    return new Decimal(candidate);
  }
  return new Decimal(fallback);
};

export const resolveExpiryDays = (params: { tierName?: string; requestedDays?: number }): number => {
  const tierName = normalizeTierName(params.tierName);
  return PILOT_TIER_DEFAULTS[tierName].expiryDays;
};

export const resolveRenewWindowMinutes = (params: {
  tierName?: string;
  requestedMinutes?: number;
}): number => {
  const tierName = normalizeTierName(params.tierName);
  const fallback = PILOT_TIER_DEFAULTS[tierName].renewWindowMinutes;
  const requested = Number(params.requestedMinutes);
  if (Number.isFinite(requested) && requested > 0 && requested <= 60 * 24 * 14) {
    return Math.floor(requested);
  }
  return fallback;
};

export const normalizeProtectionType = (value?: string): ProtectionType =>
  String(value || "").toLowerCase() === "short" ? "short" : "long";

export const computeTriggerPrice = (
  entryPrice: Decimal,
  adverseMovePct: Decimal,
  protectionType: ProtectionType
): Decimal =>
  protectionType === "short"
    ? entryPrice.mul(new Decimal(1).plus(adverseMovePct))
    : entryPrice.mul(new Decimal(1).minus(adverseMovePct));

export const computeFloorPrice = (entryPrice: Decimal, drawdownFloorPct: Decimal): Decimal =>
  computeTriggerPrice(entryPrice, drawdownFloorPct, "long");

export const computePayoutDue = (params: {
  protectedNotional: Decimal;
  entryPrice: Decimal;
  triggerPrice: Decimal;
  expiryPrice: Decimal;
  protectionType: ProtectionType;
}): Decimal => {
  if (params.entryPrice.lte(0) || params.protectedNotional.lte(0)) return new Decimal(0);
  if (params.protectionType === "short") {
    if (params.expiryPrice.lessThanOrEqualTo(params.triggerPrice)) return new Decimal(0);
    const moveAboveTrigger = params.expiryPrice.minus(params.triggerPrice);
    return moveAboveTrigger.div(params.entryPrice).mul(params.protectedNotional);
  }
  if (params.expiryPrice.greaterThanOrEqualTo(params.triggerPrice)) return new Decimal(0);
  const lossBelowTrigger = params.triggerPrice.minus(params.expiryPrice);
  return lossBelowTrigger.div(params.entryPrice).mul(params.protectedNotional);
};

