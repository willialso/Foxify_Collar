import Decimal from "decimal.js";
import { RiskControlsConfig } from "./riskControls";
import type { LadderSnapshot } from "./deribitIvLadder";

export type NormalizedIv = {
  raw: number;
  scaled: number;
};

export type FeeRegimeResult = {
  fee: Decimal;
  regime: "low" | "normal" | "high" | null;
  multiplier: Decimal | null;
};

export type FeeLeverageResult = {
  fee: Decimal;
  multiplier: Decimal | null;
};

export type FeeBaseResult = {
  feeUsdc: Decimal;
  feeRegime: {
    regime: "low" | "normal" | "high" | null;
    multiplier: Decimal | null;
  };
  feeLeverage: {
    multiplier: Decimal | null;
  };
  feeIv: NormalizedIv;
};

export type CtcResult = {
  feeUsdc: Decimal | null;
  baseIv: number | null;
  hedgeIv: number | null;
};

export function normalizeIvValue(iv: number): NormalizedIv {
  const raw = Number.isFinite(iv) && iv > 0 ? iv : 0;
  if (!raw) return { raw: 0, scaled: 0 };
  const scaled = raw < 1.5 ? raw * 100 : raw;
  return {
    raw,
    scaled: Number.isFinite(scaled) && scaled > 0 ? scaled : 0
  };
}

export function applyMinFee(
  tierName: string,
  feeUsdc: Decimal,
  riskControls: RiskControlsConfig
): Decimal {
  const minFee = riskControls.min_fee_usdc_by_tier?.[tierName];
  if (!minFee || !Number.isFinite(minFee)) return feeUsdc;
  return Decimal.max(feeUsdc, new Decimal(minFee));
}

export function applyDurationFee(
  feeUsdc: Decimal,
  targetDays: number,
  riskControls: RiskControlsConfig
): Decimal {
  const baseDays = riskControls.default_target_days ?? 7;
  const perDayPct = riskControls.duration_fee_per_day_pct ?? 0;
  const maxPct = riskControls.duration_fee_max_pct ?? 0;
  if (!perDayPct || targetDays <= baseDays) return feeUsdc;
  const extraDays = Math.max(0, targetDays - baseDays);
  const upliftPct = Math.min(maxPct, extraDays * perDayPct);
  return feeUsdc.mul(new Decimal(1).add(new Decimal(upliftPct)));
}

export function applyFeeRegime(
  tierName: string,
  feeUsdc: Decimal,
  iv: number | undefined,
  riskControls: RiskControlsConfig
): FeeRegimeResult {
  if (!iv) return { fee: feeUsdc, regime: null, multiplier: null };
  const thresholds = riskControls.fee_iv_regime_thresholds;
  if (!thresholds || !Number.isFinite(thresholds.low) || !Number.isFinite(thresholds.high)) {
    return { fee: feeUsdc, regime: null, multiplier: null };
  }
  const regime = iv < thresholds.low ? "low" : iv > thresholds.high ? "high" : "normal";
  const multiplierRaw =
    riskControls.fee_iv_regime_multipliers_by_tier?.[tierName]?.[regime] ?? 1;
  if (!Number.isFinite(multiplierRaw) || multiplierRaw === 1) {
    return { fee: feeUsdc, regime, multiplier: new Decimal(1) };
  }
  const multiplier = new Decimal(multiplierRaw);
  return {
    fee: feeUsdc.mul(multiplier),
    regime,
    multiplier
  };
}

function findLeverageMultiplier(
  leverage: number | undefined,
  multipliers: Record<string, number> | undefined
): number | null {
  if (!multipliers) return null;
  const lev = Number(leverage ?? 1);
  const entries = Object.entries(multipliers)
    .map(([key, value]) => ({ leverage: Number(key), multiplier: value }))
    .filter((entry) => Number.isFinite(entry.leverage) && Number.isFinite(entry.multiplier))
    .sort((a, b) => a.leverage - b.leverage);
  if (!entries.length) return null;
  let selected = entries[0].multiplier;
  for (const entry of entries) {
    if (entry.leverage <= lev) selected = entry.multiplier;
  }
  return Number.isFinite(selected) ? selected : null;
}

export function applyLeverageFee(
  feeUsdc: Decimal,
  leverage: number | undefined,
  riskControls: RiskControlsConfig
): FeeLeverageResult {
  const selected = findLeverageMultiplier(leverage, riskControls.fee_leverage_multipliers_by_x);
  if (!Number.isFinite(selected) || !selected || selected === 0 || selected === 1) {
    return { fee: feeUsdc, multiplier: new Decimal(1) };
  }
  return {
    fee: feeUsdc.mul(new Decimal(selected)),
    multiplier: new Decimal(selected)
  };
}

export function applyBronzeFixedFee(
  tierName: string,
  leverage: number,
  feeUsdc: Decimal
): { fee: Decimal; applied: boolean } {
  if (tierName !== "Pro (Bronze)") {
    return { fee: feeUsdc, applied: false };
  }
  return { fee: feeUsdc, applied: true };
}

export function applyIvFeeUplift(
  tierName: string,
  feeUsdc: Decimal,
  iv: number | undefined,
  riskControls: RiskControlsConfig
): Decimal {
  if (!iv) return feeUsdc;
  const threshold = riskControls.fee_iv_uplift_threshold ?? riskControls.volatility_throttle_iv ?? 0.8;
  if (iv <= threshold) return feeUsdc;
  const uplift = riskControls.fee_iv_uplift_pct_by_tier?.[tierName] ?? 0;
  if (!uplift) return feeUsdc;
  return feeUsdc.mul(new Decimal(1).add(new Decimal(uplift)));
}

function selectClosestBucket(value: number, buckets: number[]): number | null {
  if (!buckets.length) return null;
  let best = buckets[0];
  let bestDiff = Math.abs(value - best);
  for (const bucket of buckets) {
    const diff = Math.abs(value - bucket);
    if (diff < bestDiff) {
      best = bucket;
      bestDiff = diff;
    }
  }
  return best;
}

export function calculateCtcSafetyFee(
  params: {
    tierName: string;
    drawdownPct: Decimal;
    spotPrice: Decimal;
    positionSize: Decimal;
    leverage: number;
  },
  ladderSnapshot: LadderSnapshot | null,
  riskControls: RiskControlsConfig
): CtcResult {
  if (!(riskControls.ctc_enabled ?? false)) {
    return { feeUsdc: null, baseIv: null, hedgeIv: null };
  }
  if (params.tierName === "Pro (Bronze)" && params.leverage <= 2) {
    return { feeUsdc: null, baseIv: null, hedgeIv: null };
  }
  if (!ladderSnapshot || !ladderSnapshot.legs.length) {
    return { feeUsdc: null, baseIv: null, hedgeIv: null };
  }

  const bucket =
    selectClosestBucket(
      params.drawdownPct.toNumber(),
      riskControls.ctc_floor_buckets ?? [0.12, 0.16, 0.2]
    ) ?? params.drawdownPct.toNumber();

  const weights = new Map<number, number>([
    [1, 0.2],
    [3, 0.3],
    [7, 0.5]
  ]);

  const floorPrice = params.spotPrice.mul(new Decimal(1).minus(params.drawdownPct));
  if (floorPrice.lte(0)) {
    return {
      feeUsdc: null,
      baseIv: ladderSnapshot.baseIv,
      hedgeIv: ladderSnapshot.hedgeIv
    };
  }

  const notionalUsdc = params.spotPrice.mul(params.positionSize).mul(new Decimal(params.leverage));
  const bufferPct = riskControls.ctc_buffer_pct ?? 0.15;
  const targetUsd = notionalUsdc
    .mul(params.drawdownPct)
    .mul(new Decimal(1).add(new Decimal(bufferPct)));

  let totalCost = new Decimal(0);

  const pickLeg = (tenorDays: number) => {
    const candidates = ladderSnapshot.legs.filter(
      (leg) =>
        Number.isFinite(leg.markPrice) &&
        !!leg.markPrice &&
        Number.isFinite(leg.strike)
    );
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const leg of candidates) {
      const tenorDiff = Math.abs(leg.tenorDays - tenorDays);
      const floorDiff = Math.abs(leg.floorPct - bucket);
      const score = tenorDiff * 10 + floorDiff;
      if (score < bestScore) {
        best = leg;
        bestScore = score;
      }
    }
    return best;
  };

  for (const [tenorDays, weight] of weights.entries()) {
    const leg = pickLeg(tenorDays);
    if (!leg || !Number.isFinite(leg.markPrice) || !leg.markPrice || !Number.isFinite(leg.strike)) {
      return {
        feeUsdc: null,
        baseIv: ladderSnapshot.baseIv,
        hedgeIv: ladderSnapshot.hedgeIv
      };
    }

    const strike = new Decimal(leg.strike);
    const intrinsic = strike.minus(floorPrice);

    if (intrinsic.lte(0)) {
      return {
        feeUsdc: null,
        baseIv: ladderSnapshot.baseIv,
        hedgeIv: ladderSnapshot.hedgeIv
      };
    }

    const legTarget = targetUsd.mul(new Decimal(weight));
    const size = legTarget.div(intrinsic);
    const markPriceBtc = new Decimal(leg.markPrice);
    const legCost = markPriceBtc.mul(params.spotPrice).mul(size);
    totalCost = totalCost.add(legCost);
  }

  const marginPct = riskControls.ctc_margin_by_tier?.[params.tierName] ?? 0.4;
  const opsBuffer = riskControls.ctc_ops_buffer_usdc_by_tier?.[params.tierName] ?? 0;

  const feeUsdc = totalCost
    .mul(new Decimal(1).add(new Decimal(marginPct)))
    .add(new Decimal(opsBuffer));

  return {
    feeUsdc,
    baseIv: ladderSnapshot.baseIv,
    hedgeIv: ladderSnapshot.hedgeIv
  };
}

export async function calculateFeeBase(
  params: {
    tierName: string;
    baseFeeUsdc: Decimal;
    targetDays: number;
    leverage: number;
    asset: string;
    ivCandidate?: number;
  },
  ivSnapshot: NormalizedIv,
  riskControls: RiskControlsConfig
): Promise<FeeBaseResult> {
  const feeIv = ivSnapshot;
  if (params.tierName === "Pro (Bronze)") {
    const fixedFee = applyMinFee(params.tierName, params.baseFeeUsdc, riskControls);
    return {
      feeUsdc: fixedFee,
      feeRegime: { regime: null, multiplier: null },
      feeLeverage: { multiplier: new Decimal(1) },
      feeIv
    };
  }
  let feeUsdc = applyMinFee(params.tierName, params.baseFeeUsdc, riskControls);
  feeUsdc = applyDurationFee(feeUsdc, params.targetDays, riskControls);

  const ctcEnabled = riskControls.ctc_enabled ?? false;
  const feeRegime = ctcEnabled
    ? { fee: feeUsdc, regime: null, multiplier: null }
    : applyFeeRegime(params.tierName, feeUsdc, feeIv.scaled, riskControls);
  feeUsdc = feeRegime.fee;

  if (!ctcEnabled && !feeRegime.regime) {
    feeUsdc = applyIvFeeUplift(params.tierName, feeUsdc, feeIv.scaled, riskControls);
  }

  const feeLeverage = ctcEnabled
    ? { fee: feeUsdc, multiplier: new Decimal(1) }
    : applyLeverageFee(feeUsdc, params.leverage, riskControls);
  feeUsdc = feeLeverage.fee;

  const bronzeFixed = applyBronzeFixedFee(params.tierName, params.leverage, feeUsdc);
  feeUsdc = bronzeFixed.fee;

  return {
    feeUsdc,
    feeRegime: {
      regime: feeRegime.regime,
      multiplier: feeRegime.multiplier
    },
    feeLeverage: {
      multiplier: feeLeverage.multiplier
    },
    feeIv
  };
}

export function applyPassThroughCap(
  baseFee: Decimal,
  allInPremium: Decimal,
  leverage: number | undefined,
  riskControls: RiskControlsConfig,
  tierName?: string
): { maxFee: Decimal | null; capped: boolean; capMultiplier: Decimal | null } {
  if (tierName && riskControls.pass_through_cap_by_tier) {
    const tierCaps = riskControls.pass_through_cap_by_tier[tierName];
    if (tierCaps) {
      const selected = findLeverageMultiplier(leverage, tierCaps);
      if (Number.isFinite(selected) && selected && selected > 0) {
        const capMultiplier = new Decimal(selected);
        const maxFee = baseFee.mul(capMultiplier);
        const capped = allInPremium.gt(maxFee);
        return { maxFee, capped, capMultiplier };
      }
    }
  }
  const selected = findLeverageMultiplier(leverage, riskControls.pass_through_cap_by_leverage);
  if (!Number.isFinite(selected) || !selected || selected === 0) {
    return { maxFee: null, capped: false, capMultiplier: null };
  }

  const capMultiplier = new Decimal(selected);
  const maxFee = baseFee.mul(capMultiplier);
  const capped = allInPremium.gt(maxFee);

  return { maxFee, capped, capMultiplier };
}

export function applyPartialDiscount(
  feeUsdc: Decimal,
  coverageRatio: Decimal,
  riskControls: RiskControlsConfig
): Decimal {
  const discountPct = riskControls.partial_coverage_discount_pct ?? 0;
  if (!discountPct) return feeUsdc;

  const coverage = Decimal.min(new Decimal(1), Decimal.max(new Decimal(0), coverageRatio));
  const discounted = feeUsdc.mul(coverage).mul(new Decimal(1).minus(new Decimal(discountPct)));

  return Decimal.max(new Decimal(0), discounted);
}

export function premiumFloorBreached(
  premiumTotal: Decimal,
  feeUsdc: Decimal,
  riskControls: RiskControlsConfig
): { breached: boolean; ratio: Decimal; threshold: Decimal } {
  const threshold = new Decimal(riskControls.premium_floor_ratio ?? 1.25);

  if (feeUsdc.lte(0)) {
    return { breached: true, ratio: new Decimal(999), threshold };
  }

  const ratio = premiumTotal.div(feeUsdc);
  return {
    breached: ratio.gt(threshold),
    ratio,
    threshold
  };
}

export function canCoverageOverride(tierName: string, riskControls: RiskControlsConfig): boolean {
  const allowed = riskControls.coverage_override_tiers ?? [];
  return allowed.includes(tierName);
}
