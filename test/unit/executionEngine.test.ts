import { beforeEach, describe, expect, test, vi } from "vitest";
import Decimal from "decimal.js";
import { executeMultiStrikeOption, selectStrikeCandidates } from "../../src/executionEngine";
import { createMockDeribitWithDefaults } from "../mocks/mockDeribitConnector";

describe("executionEngine", () => {
  let mockDeribit: ReturnType<typeof createMockDeribitWithDefaults>;

  beforeEach(() => {
    mockDeribit = createMockDeribitWithDefaults();
  });

  test("selectStrikeCandidates returns top 3 by liquidity score", async () => {
    const candidates = await selectStrikeCandidates(
      {
        spotPrice: new Decimal(100000),
        drawdownFloorPct: new Decimal(0.12),
        optionType: "put",
        expiryTag: "1FEB25",
        targetDays: 1
      },
      mockDeribit as any
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(3);
    expect(candidates[0].liquidityScore).toBeGreaterThanOrEqual(0);
  });

  test("selectStrikeCandidates filters by strike proximity", async () => {
    const candidates = await selectStrikeCandidates(
      {
        spotPrice: new Decimal(100000),
        drawdownFloorPct: new Decimal(0.12),
        optionType: "put",
        expiryTag: "1FEB25",
        targetDays: 1
      },
      mockDeribit as any
    );

    const targetStrike = 100000 * (1 - 0.12);
    candidates.forEach((candidate) => {
      expect(candidate.strike).toBeGreaterThanOrEqual(targetStrike);
    });
  });

  test("executeMultiStrikeOption retries on failure", async () => {
    const placeOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        result: { filled_amount: 0.5, average_price: 0.016 }
      });

    const mockRegistry = { placeOrder } as any;

    const result = await executeMultiStrikeOption(
      {
        candidates: [
          {
            instrument: "BTC-1FEB25-88000-P",
            strike: 88000,
            expiryTag: "1FEB25",
            tenorDays: 1,
            markPrice: 0.015,
            askPrice: 0.016,
            bidPrice: 0.014,
            openInterest: 10,
            bidAskSpread: 0.14,
            liquidityScore: 0.8
          }
        ],
        targetSize: new Decimal(0.5),
        spotPrice: new Decimal(100000),
        side: "buy"
      },
      mockRegistry
    );

    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(result.totalFilled.toNumber()).toBe(0.5);
  });
});
