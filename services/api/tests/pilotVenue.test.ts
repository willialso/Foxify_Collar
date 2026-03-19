import assert from "node:assert/strict";
import test from "node:test";
import { createPilotVenueAdapter, mapVenueFailureReason } from "../src/pilot/venue";

test("mock_falconx adapter returns quote and execution", async () => {
  const adapter = createPilotVenueAdapter({
    mode: "mock_falconx",
    falconx: {
      baseUrl: "https://api.falconx.io",
      apiKey: "key",
      secret: "c2VjcmV0",
      passphrase: "pass"
    },
    deribit: {} as any
  });
  const quote = await adapter.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-7D-P",
    protectedNotional: 10000,
    quantity: 0.1,
    side: "buy"
  });
  assert.equal(quote.venue, "mock_falconx");
  const execution = await adapter.execute(quote);
  assert.equal(execution.status, "success");
});

test("mapVenueFailureReason normalizes known errors", () => {
  assert.equal(mapVenueFailureReason(new Error("QUOTE_EXPIRED")), "quote_expired");
  assert.equal(mapVenueFailureReason(new Error("INVALID_QUOTE_ID")), "invalid_quote_id");
  assert.equal(mapVenueFailureReason(new Error("INSUFFICIENT_CASH_BALANCE")), "insufficient_balance");
  assert.equal(mapVenueFailureReason(new Error("other")), "venue_error");
});

test("deribit adapter supports optional mark fallback policy", async () => {
  const connector = {
    getIndexPrice: async () => ({ result: { index_price: 100000 } }),
    listInstruments: async () => ({ result: [] }),
    getOrderBook: async () => ({
      result: {
        asks: [],
        bids: [[0.03, 2]],
        mark_price: 0.02
      }
    }),
    placeOrder: async () => ({ status: "filled", fillPrice: 0.02, filledAmount: 0.01, id: "ord-1" })
  } as any;

  const withFallback = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: {
      baseUrl: "https://api.falconx.io",
      apiKey: "key",
      secret: "c2VjcmV0",
      passphrase: "pass"
    },
    deribit: connector,
    deribitQuotePolicy: "ask_or_mark_fallback"
  });
  const fallbackQuote = await withFallback.quote({
    marketId: "BTC-USD",
    instrumentId: "BTC-28MAR26-80000-P",
    protectedNotional: 1000,
    quantity: 0.01,
    side: "buy"
  });
  assert.equal(fallbackQuote.details?.source, "requested_instrument_mark_fallback");
  assert.equal(fallbackQuote.premium, 20);

  const askOnly = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: {
      baseUrl: "https://api.falconx.io",
      apiKey: "key",
      secret: "c2VjcmV0",
      passphrase: "pass"
    },
    deribit: connector,
    deribitQuotePolicy: "ask_only"
  });
  await assert.rejects(
    async () =>
      askOnly.quote({
        marketId: "BTC-USD",
        instrumentId: "BTC-28MAR26-80000-P",
        protectedNotional: 1000,
        quantity: 0.01,
        side: "buy"
      }),
    /deribit_quote_unavailable/
  );
});

test("deribit adapter strike selection can align to trigger", async () => {
  const expiry = Date.now() + 8 * 86400000;
  const orderBooks: Record<string, any> = {
    "BTC-28MAR26-80000-P": { result: { asks: [[0.02, 2]], bids: [[0.015, 2]] } },
    "BTC-28MAR26-90000-P": { result: { asks: [[0.04, 2]], bids: [[0.035, 2]] } }
  };
  const connector = {
    getIndexPrice: async () => ({ result: { index_price: 100000 } }),
    listInstruments: async () => ({
      result: [
        {
          instrument_name: "BTC-28MAR26-80000-P",
          option_type: "put",
          strike: 80000,
          expiration_timestamp: expiry
        },
        {
          instrument_name: "BTC-28MAR26-90000-P",
          option_type: "put",
          strike: 90000,
          expiration_timestamp: expiry
        }
      ]
    }),
    getOrderBook: async (instrumentId: string) => orderBooks[instrumentId],
    placeOrder: async () => ({ status: "filled", fillPrice: 0.02, filledAmount: 0.01, id: "ord-1" })
  } as any;

  const legacy = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: {
      baseUrl: "https://api.falconx.io",
      apiKey: "key",
      secret: "c2VjcmV0",
      passphrase: "pass"
    },
    deribit: connector,
    deribitQuotePolicy: "ask_only",
    deribitStrikeSelectionMode: "legacy"
  });
  const triggerAligned = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: {
      baseUrl: "https://api.falconx.io",
      apiKey: "key",
      secret: "c2VjcmV0",
      passphrase: "pass"
    },
    deribit: connector,
    deribitQuotePolicy: "ask_only",
    deribitStrikeSelectionMode: "trigger_aligned"
  });

  const req = {
    marketId: "BTC-USD",
    instrumentId: "BTC-USD-7D-P",
    protectedNotional: 1000,
    quantity: 0.01,
    side: "buy" as const
  };
  const legacyQuote = await legacy.quote(req);
  const triggerQuote = await triggerAligned.quote({
    ...req,
    triggerPrice: 90000
  });
  assert.equal(legacyQuote.instrumentId, "BTC-28MAR26-80000-P");
  assert.equal(triggerQuote.instrumentId, "BTC-28MAR26-90000-P");
});

test("deribit adapter execution uses filled quantity", async () => {
  const connector = {
    getIndexPrice: async () => ({ result: { index_price: 100000 } }),
    listInstruments: async () => ({ result: [] }),
    getOrderBook: async () => ({ result: { asks: [[0.02, 2]], bids: [[0.015, 2]] } }),
    placeOrder: async () => ({
      status: "filled",
      fillPrice: 0.02,
      filledAmount: 0.06,
      id: "ord-2"
    })
  } as any;
  const adapter = createPilotVenueAdapter({
    mode: "deribit_test",
    falconx: {
      baseUrl: "https://api.falconx.io",
      apiKey: "key",
      secret: "c2VjcmV0",
      passphrase: "pass"
    },
    deribit: connector,
    deribitQuotePolicy: "ask_only"
  });

  const execution = await adapter.execute({
    venue: "deribit_test",
    quoteId: "q-1",
    rfqId: null,
    instrumentId: "BTC-28MAR26-80000-P",
    side: "buy",
    quantity: 0.1,
    premium: 1000,
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    quoteTs: new Date().toISOString(),
    details: {}
  });
  assert.equal(execution.status, "success");
  assert.equal(execution.quantity, 0.06);
  assert.equal(execution.premium, 600);
});

