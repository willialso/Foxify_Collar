import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import { ExecutionRegistry, VenueExecutor } from "../src/executionRegistry";

describe("server endpoints", () => {
  it("GET /health returns ok", async () => {
    const { app } = await createServer({
      riskControls: { ctc_enabled: false } as any,
      ivCache: { getAtmIv: async () => new Decimal(0.6) } as any,
      ivLadder: { getSnapshot: () => null, start: () => undefined } as any,
      executionRegistry: new ExecutionRegistry(),
      auditLogPath: "/tmp/foxify-audit.log"
    });

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe("ok");
  });

  it("POST /pricing/ctc returns quote", async () => {
    const registry = new ExecutionRegistry();
    const executor: VenueExecutor = {
      placeOrder: async () => ({ result: { filled_amount: 0.1, average_price: 0.02 } })
    };
    registry.register("deribit", executor);

    const { app } = await createServer({
      riskControls: {
        ctc_enabled: false,
        min_fee_usdc_by_tier: { "Pro (Bronze)": 20 },
        fee_iv_regime_thresholds: { low: 0.5, high: 0.8 },
        fee_iv_regime_multipliers_by_tier: { "Pro (Bronze)": { low: 0.9, normal: 1, high: 1.2 } },
        fee_iv_uplift_pct_by_tier: { "Pro (Bronze)": 0.1 },
        fee_iv_uplift_threshold: 0.8
      } as any,
      ivCache: { getAtmIv: async () => new Decimal(0.6) } as any,
      ivLadder: { getSnapshot: () => null, start: () => undefined } as any,
      executionRegistry: registry,
      auditLogPath: "/tmp/foxify-audit.log"
    });

    const res = await app.inject({
      method: "POST",
      url: "/pricing/ctc",
      payload: {
        tierName: "Pro (Bronze)",
        asset: "BTC",
        spotPrice: 100000,
        drawdownFloorPct: 0.12,
        positionSize: 0.5,
        leverage: 5,
        targetDays: 7
      }
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe("ok");
    expect(json.feeUsdc).toBeDefined();
  });

  it("POST /coverage/activate returns success on perp fallback", async () => {
    const registry = new ExecutionRegistry();
    const executor: VenueExecutor = {
      placeOrder: async () => ({ result: { filled_amount: 0.5, average_price: 100000 } })
    };
    registry.register("deribit", executor);

    const mockConnector = {
      listInstruments: async () => ({ result: [] }),
      getTicker: async () => ({ result: {} })
    } as any;

    const { app } = await createServer({
      deribit: mockConnector,
      riskControls: { ctc_enabled: false } as any,
      ivCache: { getAtmIv: async () => new Decimal(0.6) } as any,
      ivLadder: { getSnapshot: () => null, start: () => undefined } as any,
      executionRegistry: registry,
      auditLogPath: "/tmp/foxify-audit.log"
    });

    const res = await app.inject({
      method: "POST",
      url: "/coverage/activate",
      payload: {
        coverageId: "cov_test_001",
        tierName: "Pro (Silver)",
        asset: "BTC",
        spotPrice: 100000,
        drawdownFloorPct: 0.12,
        positionSize: 0.5,
        leverage: 5,
        targetDays: 7,
        expiryTag: "8FEB25",
        feeUsdc: 45,
        allowPerpFallback: true
      }
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe("success");
    expect(json.executionStatus).toBe("perp_fallback");
  });
});
