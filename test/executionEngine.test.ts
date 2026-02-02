import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  buildExecutionPlan,
  executeMultiStrikeOption,
  executePerpFallback,
  selectStrikeCandidates
} from "../src/executionEngine";
import { ExecutionRegistry, VenueExecutor } from "../src/executionRegistry";

describe("selectStrikeCandidates", () => {
  it("returns top 3 by liquidity", async () => {
    const mockConnector = {
      listInstruments: async () => ({
        result: [
          {
            instrument_name: "BTC-1FEB25-90000-P",
            option_type: "put",
            strike: 90000,
            open_interest: 1,
            expiration_timestamp: Date.now() + 24 * 60 * 60 * 1000
          },
          {
            instrument_name: "BTC-1FEB25-89000-P",
            option_type: "put",
            strike: 89000,
            open_interest: 2,
            expiration_timestamp: Date.now() + 24 * 60 * 60 * 1000
          },
          {
            instrument_name: "BTC-1FEB25-88000-P",
            option_type: "put",
            strike: 88000,
            open_interest: 3,
            expiration_timestamp: Date.now() + 24 * 60 * 60 * 1000
          },
          {
            instrument_name: "BTC-1FEB25-87000-P",
            option_type: "put",
            strike: 87000,
            open_interest: 4,
            expiration_timestamp: Date.now() + 24 * 60 * 60 * 1000
          }
        ]
      }),
      getTicker: async () => ({
        result: {
          mark_price: 0.02,
          best_ask_price: 0.021,
          best_bid_price: 0.019
        }
      })
    } as any;

    const candidates = await selectStrikeCandidates(
      {
        spotPrice: new Decimal(100000),
        drawdownFloorPct: new Decimal(0.12),
        optionType: "put",
        expiryTag: "1FEB25",
        targetDays: 1
      },
      mockConnector
    );

    expect(candidates.length).toBeLessThanOrEqual(3);
    if (candidates.length > 1) {
      expect(candidates[0].liquidityScore).toBeGreaterThanOrEqual(
        candidates[1].liquidityScore
      );
    }
  });
});

describe("executeMultiStrikeOption", () => {
  it("accepts partial fill >= 50%", async () => {
    const registry = new ExecutionRegistry();
    const executor: VenueExecutor = {
      placeOrder: async () => ({
        result: { filled_amount: 0.3, average_price: 0.02, order: { order_id: "1" } }
      })
    };
    registry.register("deribit", executor);

    const result = await executeMultiStrikeOption(
      {
        candidates: [
          {
            instrument: "BTC-1FEB25-88000-P",
            strike: 88000,
            expiryTag: "1FEB25",
            tenorDays: 1,
            markPrice: 0.02,
            askPrice: 0.021,
            bidPrice: 0.019,
            openInterest: 1,
            bidAskSpread: 0.01,
            liquidityScore: 0.9
          }
        ],
        targetSize: new Decimal(0.5),
        spotPrice: new Decimal(100000),
        side: "buy"
      },
      registry
    );

    expect(result.status).toBe("partial");
    expect(result.coverageRatio.toNumber()).toBeGreaterThanOrEqual(0.5);
  });
});

describe("executePerpFallback", () => {
  it("uses BTC-PERPETUAL", async () => {
    const registry = new ExecutionRegistry();
    const executor: VenueExecutor = {
      placeOrder: async () => ({
        result: { filled_amount: 0.5, average_price: 100000, order: { order_id: "2" } }
      })
    };
    registry.register("deribit", executor);

    const result = await executePerpFallback(
      {
        targetSize: new Decimal(0.5),
        spotPrice: new Decimal(100000),
        side: "sell"
      },
      registry
    );

    expect(result.status).toBe("perp_fallback");
    expect(result.finalInstrument).toBe("BTC-PERPETUAL");
    expect(result.totalFilled.toNumber()).toBeGreaterThan(0);
  });
});

describe("buildExecutionPlan", () => {
  it("returns failed when no candidates and no fallback", async () => {
    const mockConnector = {
      listInstruments: async () => ({ result: [] }),
      getTicker: async () => ({ result: {} })
    } as any;
    const registry = new ExecutionRegistry();

    const result = await buildExecutionPlan(
      {
        spotPrice: new Decimal(100000),
        drawdownFloorPct: new Decimal(0.12),
        targetSize: new Decimal(0.5),
        optionType: "put",
        expiryTag: "1FEB25",
        targetDays: 1,
        allowPerpFallback: false
      },
      mockConnector,
      registry
    );

    expect(result.status).toBe("failed");
  });
});
