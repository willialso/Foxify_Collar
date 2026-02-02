import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Decimal from "decimal.js";
import { createServer } from "../../src/server";
import { ExecutionRegistry } from "../../src/executionRegistry";
import { createMockDeribitWithDefaults } from "../mocks/mockDeribitConnector";
import { LADDER_SNAPSHOT_NORMAL } from "../fixtures/ladderSnapshots";

describe("API Integration", () => {
  let app: any;

  beforeAll(async () => {
    const mockDeribit = createMockDeribitWithDefaults();
    const registry = new ExecutionRegistry();

    const { app: serverApp } = await createServer({
      deribit: mockDeribit as any,
      executionRegistry: registry,
      riskControls: {
        ctc_enabled: true,
        min_fee_usdc_by_tier: { "Pro (Bronze)": 20, "Pro (Silver)": 30 },
        fee_iv_regime_thresholds: { low: 0.5, high: 0.8 },
        fee_iv_regime_multipliers_by_tier: { "Pro (Bronze)": { low: 0.9, normal: 1, high: 1.2 } },
        ctc_margin_by_tier: { "Pro (Bronze)": 0.6 },
        ctc_ops_buffer_usdc_by_tier: { "Pro (Bronze)": 1 },
        ctc_floor_buckets: [0.12, 0.16, 0.2],
        ctc_buffer_pct: 0.15
      } as any,
      ivCache: { getAtmIv: async () => new Decimal(0.6) } as any,
      ivLadder: {
        getSnapshot: () => LADDER_SNAPSHOT_NORMAL,
        start: () => undefined
      } as any,
      auditLogPath: "/tmp/foxify-audit.log"
    });

    app = serverApp;
  });

  afterAll(async () => {
    await app.close();
  });

  test("POST /pricing/ctc returns valid quote", async () => {
    const response = await app.inject({
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

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe("ok");
    expect(json.feeUsdc).toBeDefined();
    expect(parseFloat(json.feeUsdc)).toBeGreaterThan(0);
    expect(json.quoteLockExpiry).toBeDefined();
  });

  test("POST /pricing/ctc caches duplicate requests", async () => {
    const payload = {
      tierName: "Pro (Silver)",
      asset: "BTC",
      spotPrice: 100000,
      drawdownFloorPct: 0.12,
      positionSize: 0.5,
      leverage: 5
    };

    const response1 = await app.inject({ method: "POST", url: "/pricing/ctc", payload });
    const response2 = await app.inject({ method: "POST", url: "/pricing/ctc", payload });

    const json1 = response1.json();
    const json2 = response2.json();

    expect(json1.feeUsdc).toBe(json2.feeUsdc);
    expect(json1.quoteLockExpiry).toBe(json2.quoteLockExpiry);
  });

  test("POST /coverage/activate executes hedge", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/coverage/activate",
      payload: {
        coverageId: "test_cov_001",
        tierName: "Pro (Silver)",
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

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe("success");
    expect(json.instrument).toBeDefined();
    expect(Array.isArray(json.attempts)).toBe(true);
  });

  test("GET /health returns server status", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe("ok");
    expect(json.timestamp).toBeDefined();
  });
});
