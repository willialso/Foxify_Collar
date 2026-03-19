import assert from "node:assert/strict";
import test from "node:test";
import { resolvePriceSnapshot } from "../src/pilot/price";

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("resolvePriceSnapshot uses primary source when valid", async () => {
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        market_id: "BTC-USD",
        oraclePrice: 100000,
        timestamp: Date.now()
      })
    }) as any) as typeof fetch;
  const result = await resolvePriceSnapshot(
    {
      primaryUrl: "https://primary",
      fallbackUrl: "https://fallback",
      primaryTimeoutMs: 800,
      fallbackTimeoutMs: 800,
      freshnessMaxMs: 5000
    },
    {
      marketId: "BTC-USD",
      now: new Date(),
      requestId: "req-1",
      endpointVersion: "v1"
    }
  );
  assert.equal(result.priceSource, "reference_oracle");
  assert.equal(result.marketId, "BTC-USD");
});

test("resolvePriceSnapshot falls back when primary payload invalid", async () => {
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          market_id: "BTC-USD",
          oraclePrice: -1,
          timestamp: Date.now()
        })
      } as any;
    }
    return {
      ok: true,
      json: async () => ({
        market_id: "BTC-USD",
        price: 99999,
        timestamp: Date.now()
      })
    } as any;
  }) as typeof fetch;
  const result = await resolvePriceSnapshot(
    {
      primaryUrl: "https://primary",
      fallbackUrl: "https://fallback",
      primaryTimeoutMs: 800,
      fallbackTimeoutMs: 800,
      freshnessMaxMs: 5000
    },
    {
      marketId: "BTC-USD",
      now: new Date(),
      requestId: "req-2",
      endpointVersion: "v1"
    }
  );
  assert.equal(result.priceSource, "fallback_oracle");
});

test("resolvePriceSnapshot retries transient invalid primary JSON", async () => {
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        text: async () => "{"
      } as any;
    }
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          market_id: "BTC-USD",
          oraclePrice: 100123.45,
          timestamp: Date.now()
        })
    } as any;
  }) as typeof fetch;
  const result = await resolvePriceSnapshot(
    {
      primaryUrl: "https://primary",
      fallbackUrl: "https://fallback",
      primaryTimeoutMs: 800,
      fallbackTimeoutMs: 800,
      freshnessMaxMs: 5000,
      requestRetryAttempts: 2,
      requestRetryDelayMs: 0
    },
    {
      marketId: "BTC-USD",
      now: new Date(),
      requestId: "req-4",
      endpointVersion: "v1"
    }
  );
  assert.equal(result.priceSource, "reference_oracle");
  assert.equal(callCount, 2);
});

test("resolvePriceSnapshot rejects when both sources invalid", async () => {
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        market_id: "BTC-USD",
        price: 0,
        timestamp: Date.now()
      })
    }) as any) as typeof fetch;
  await assert.rejects(
    () =>
      resolvePriceSnapshot(
        {
          primaryUrl: "https://primary",
          fallbackUrl: "https://fallback",
          primaryTimeoutMs: 800,
          fallbackTimeoutMs: 800,
          freshnessMaxMs: 5000
        },
        {
          marketId: "BTC-USD",
          now: new Date(),
          requestId: "req-3",
          endpointVersion: "v1"
        }
      ),
    /price_unavailable/
  );
});

test("resolvePriceSnapshot supports Deribit-style primary payload shape", async () => {
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        result: {
          index_price: 100250.5,
          timestamp: Date.now()
        }
      })
    }) as any) as typeof fetch;
  const result = await resolvePriceSnapshot(
    {
      primaryUrl: "https://primary",
      fallbackUrl: "https://fallback",
      primaryTimeoutMs: 800,
      fallbackTimeoutMs: 800,
      freshnessMaxMs: 30000
    },
    {
      marketId: "BTC-USD",
      now: new Date(),
      requestId: "req-deribit-shape",
      endpointVersion: "v1"
    }
  );
  assert.equal(result.priceSource, "reference_oracle");
  assert.equal(result.marketId, "BTC-USD");
  assert.ok(Number(result.price) > 0);
});

test("resolvePriceSnapshot supports Coinbase-style fallback timestamp field", async () => {
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          market_id: "BTC-USD",
          oraclePrice: -1,
          timestamp: Date.now()
        })
      } as any;
    }
    return {
      ok: true,
      json: async () => ({
        price: "99999.12",
        time: new Date().toISOString()
      })
    } as any;
  }) as typeof fetch;
  const result = await resolvePriceSnapshot(
    {
      primaryUrl: "https://primary",
      fallbackUrl: "https://fallback",
      primaryTimeoutMs: 800,
      fallbackTimeoutMs: 800,
      freshnessMaxMs: 30000
    },
    {
      marketId: "BTC-USD",
      now: new Date(),
      requestId: "req-coinbase-fallback-shape",
      endpointVersion: "v1"
    }
  );
  assert.equal(result.priceSource, "fallback_oracle");
  assert.equal(result.marketId, "BTC-USD");
  assert.ok(Number(result.price) > 0);
});

