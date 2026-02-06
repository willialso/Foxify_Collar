import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  applyBronzeFixedFee,
  applyMinFee,
  calculateCtcSafetyFee,
  calculateFeeBase,
  normalizeIvValue
} from "../src/pricingEngine";

describe("normalizeIvValue", () => {
  it("handles decimal format", () => {
    const result = normalizeIvValue(0.65);
    expect(result.raw).toBe(0.65);
    expect(result.scaled).toBe(65);
  });

  it("handles percentage format", () => {
    const result = normalizeIvValue(65);
    expect(result.raw).toBe(65);
    expect(result.scaled).toBe(65);
  });
});

describe("applyMinFee", () => {
  it("enforces tier minimum", () => {
    const riskControls = {
      min_fee_usdc_by_tier: { "Pro (Bronze)": 20 }
    } as any;
    const result = applyMinFee("Pro (Bronze)", new Decimal(15), riskControls);
    expect(result.toNumber()).toBe(20);
  });
});

describe("applyBronzeFixedFee", () => {
  it("keeps fee unchanged for Bronze", () => {
    const result = applyBronzeFixedFee("Pro (Bronze)", 1.5, new Decimal(35));
    expect(result.fee.toNumber()).toBe(35);
    expect(result.applied).toBe(true);
  });
});

describe("calculateCtcSafetyFee", () => {
  it("uses weighted ladder", () => {
    const ladder = {
      baseIv: 0.6,
      hedgeIv: 0.75,
      ts: Date.now(),
      instruments: ["BTC-1FEB-95000-P", "BTC-4FEB-95000-P", "BTC-8FEB-95000-P"],
      legs: [
        {
          tenorDays: 1,
          floorPct: 0.12,
          instrument: "BTC-1FEB-95000-P",
          strike: 95000,
          markIv: 0.6,
          markPrice: 0.02
        },
        {
          tenorDays: 3,
          floorPct: 0.12,
          instrument: "BTC-4FEB-95000-P",
          strike: 95000,
          markIv: 0.65,
          markPrice: 0.025
        },
        {
          tenorDays: 7,
          floorPct: 0.12,
          instrument: "BTC-8FEB-95000-P",
          strike: 95000,
          markIv: 0.7,
          markPrice: 0.03
        }
      ],
      spot: 100000
    };

    const riskControls = {
      ctc_enabled: true,
      ctc_margin_by_tier: { "Pro (Bronze)": 0.6 },
      ctc_ops_buffer_usdc_by_tier: { "Pro (Bronze)": 1 },
      ctc_floor_buckets: [0.12, 0.16, 0.2],
      ctc_buffer_pct: 0.15
    } as any;

    const result = calculateCtcSafetyFee(
      {
        tierName: "Pro (Bronze)",
        drawdownPct: new Decimal(0.12),
        spotPrice: new Decimal(100000),
        positionSize: new Decimal(0.1),
        leverage: 5
      },
      ladder,
      riskControls
    );

    expect(result.feeUsdc).not.toBeNull();
    expect(result.baseIv).toBe(0.6);
    expect(result.hedgeIv).toBe(0.75);
    expect(result.feeUsdc?.toNumber()).toBeGreaterThan(0);
  });
});

describe("calculateFeeBase", () => {
  it("orchestrates all adjustments", async () => {
    const riskControls = {
      min_fee_usdc_by_tier: { "Pro (Silver)": 30 },
      default_target_days: 7,
      duration_fee_per_day_pct: 0.04,
      duration_fee_max_pct: 0.6,
      ctc_enabled: false,
      fee_iv_regime_thresholds: { low: 0.5, high: 0.8 },
      fee_iv_regime_multipliers_by_tier: {
        "Pro (Silver)": { low: 0.9, normal: 1.0, high: 1.2 }
      },
      fee_leverage_multipliers_by_x: { "2": 1.05, "5": 1.15, "10": 1.3 }
    } as any;

    const ivSnapshot = { raw: 0.85, scaled: 85 };

    const result = await calculateFeeBase(
      {
        tierName: "Pro (Silver)",
        baseFeeUsdc: new Decimal(25),
        targetDays: 10,
        leverage: 5,
        asset: "BTC"
      },
      ivSnapshot,
      riskControls
    );

    expect(result.feeUsdc.toNumber()).toBeGreaterThan(30);
    expect(result.feeRegime.regime).toBe("high");
    expect(result.feeLeverage.multiplier?.toNumber()).toBe(1.15);
  });
});
