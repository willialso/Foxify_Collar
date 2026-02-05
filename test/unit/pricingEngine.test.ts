import { describe, expect, test } from "vitest";
import Decimal from "decimal.js";
import {
  applyBronzeFixedFee,
  applyDurationFee,
  applyFeeRegime,
  applyLeverageFee,
  applyMinFee,
  calculateCtcSafetyFee,
  normalizeIvValue
} from "../../src/pricingEngine";
import { LADDER_SNAPSHOT_NORMAL } from "../fixtures/ladderSnapshots";

describe("pricingEngine", () => {
  const mockRiskControls = {
    min_fee_usdc_by_tier: { "Pro (Bronze)": 20, "Pro (Silver)": 30 },
    default_target_days: 7,
    duration_fee_per_day_pct: 0.04,
    duration_fee_max_pct: 0.6,
    fee_iv_regime_thresholds: { low: 0.5, high: 0.8 },
    fee_iv_regime_multipliers_by_tier: {
      "Pro (Silver)": { low: 0.9, normal: 1.0, high: 1.2 }
    },
    fee_leverage_multipliers_by_x: { "2": 1.05, "5": 1.15, "10": 1.3 },
    ctc_enabled: true,
    ctc_margin_by_tier: { "Pro (Bronze)": 0.6 },
    ctc_ops_buffer_usdc_by_tier: { "Pro (Bronze)": 1 },
    ctc_floor_buckets: [0.12, 0.16, 0.2],
    ctc_buffer_pct: 0.15
  };

  test("normalizeIvValue converts decimal to percentage", () => {
    const result = normalizeIvValue(0.65);
    expect(result.raw).toBe(0.65);
    expect(result.scaled).toBe(65);
  });

  test("normalizeIvValue handles percentage input", () => {
    const result = normalizeIvValue(65);
    expect(result.raw).toBe(65);
    expect(result.scaled).toBe(65);
  });

  test("applyMinFee enforces tier minimum", () => {
    const result = applyMinFee("Pro (Bronze)", new Decimal(15), mockRiskControls as any);
    expect(result.toNumber()).toBe(20);
  });

  test("applyDurationFee adds uplift for extended duration", () => {
    const result = applyDurationFee(new Decimal(30), 10, mockRiskControls as any);
    expect(result.toNumber()).toBe(30 * 1.12);
  });

  test("applyFeeRegime returns high regime for IV > 0.8", () => {
    const result = applyFeeRegime("Pro (Silver)", new Decimal(30), 0.85, mockRiskControls as any);
    expect(result.regime).toBe("high");
    expect(result.multiplier?.toNumber()).toBe(1.2);
    expect(result.fee.toNumber()).toBe(30 * 1.2);
  });

  test("applyLeverageFee applies multiplier for leverage", () => {
    const result = applyLeverageFee(new Decimal(30), 5, mockRiskControls as any);
    expect(result.multiplier?.toNumber()).toBe(1.15);
    expect(result.fee.toNumber()).toBe(30 * 1.15);
  });

  test("applyBronzeFixedFee keeps fee unchanged for Bronze", () => {
    const result = applyBronzeFixedFee("Pro (Bronze)", 1.5, new Decimal(35));
    expect(result.fee.toNumber()).toBe(35);
    expect(result.applied).toBe(true);
  });

  test("calculateCtcSafetyFee uses weighted ladder (20/30/50)", () => {
    const result = calculateCtcSafetyFee(
      {
        tierName: "Pro (Bronze)",
        drawdownPct: new Decimal(0.12),
        spotPrice: new Decimal(100000),
        positionSize: new Decimal(0.1),
        leverage: 5
      },
      LADDER_SNAPSHOT_NORMAL,
      mockRiskControls as any
    );

    expect(result.feeUsdc).not.toBeNull();
    expect(result.baseIv).toBe(0.6);
    expect(result.hedgeIv).toBe(0.75);
    expect(result.feeUsdc!.toNumber()).toBeGreaterThan(0);
  });

  test("calculateCtcSafetyFee returns null for Bronze ≤2x", () => {
    const result = calculateCtcSafetyFee(
      {
        tierName: "Pro (Bronze)",
        drawdownPct: new Decimal(0.12),
        spotPrice: new Decimal(100000),
        positionSize: new Decimal(0.1),
        leverage: 1.5
      },
      LADDER_SNAPSHOT_NORMAL,
      mockRiskControls as any
    );

    expect(result.feeUsdc).toBeNull();
  });
});
