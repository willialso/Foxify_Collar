import { createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { DeribitConnector } from "@foxify/connectors";
import type {
  DeribitQuotePolicy,
  DeribitStrikeSelectionMode,
  PilotVenueMode
} from "./config";
import type { VenueExecution, VenueQuote } from "./types";

export type QuoteRequest = {
  marketId: string;
  instrumentId: string;
  protectedNotional: number;
  quantity: number;
  side: "buy";
  triggerPrice?: number;
  protectionType?: "long" | "short";
  clientOrderId?: string;
};

type FalconxConfig = {
  baseUrl: string;
  apiKey: string;
  secret: string;
  passphrase: string;
};

const nowIso = (): string => new Date().toISOString();

const timestampSeconds = (): string => (Date.now() / 1000).toFixed(3);

const signFalconx = (params: {
  secret: string;
  timestamp: string;
  method: string;
  requestPath: string;
  body: string;
}): string => {
  const decoded = Buffer.from(params.secret, "base64");
  const prehash = `${params.timestamp}${params.method.toUpperCase()}${params.requestPath}${params.body}`;
  return createHmac("sha256", decoded).update(prehash).digest("base64");
};

const falconxRequest = async (
  config: FalconxConfig,
  path: string,
  method: "GET" | "POST",
  body: Record<string, unknown> | null
): Promise<any> => {
  const payload = body ? JSON.stringify(body) : "";
  const ts = timestampSeconds();
  const signature = signFalconx({
    secret: config.secret,
    timestamp: ts,
    method,
    requestPath: path,
    body: payload
  });
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "FX-ACCESS-KEY": config.apiKey,
      "FX-ACCESS-SIGN": signature,
      "FX-ACCESS-TIMESTAMP": ts,
      "FX-ACCESS-PASSPHRASE": config.passphrase
    },
    body: body ? payload : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`falconx_http_${res.status}:${text}`);
  }
  return await res.json();
};

const DERIBIT_OPTION_REGEX = /^BTC-\d{1,2}[A-Z]{3}\d{2}-\d+-(P|C)$/i;

const parseDeribitStrike = (instrumentId: string): number | null => {
  const parts = String(instrumentId || "").split("-");
  if (parts.length < 4) return null;
  const strike = Number(parts[2]);
  return Number.isFinite(strike) && strike > 0 ? strike : null;
};

const extractTopOfBook = (orderBookPayload: any): {
  ask: number | null;
  askSize: number | null;
  bid: number | null;
} => {
  const orderBook = orderBookPayload?.result ?? orderBookPayload;
  const ask = Number(orderBook?.asks?.[0]?.[0] ?? orderBook?.best_ask_price ?? 0);
  const askSize = Number(orderBook?.asks?.[0]?.[1] ?? orderBook?.best_ask_amount ?? 0);
  const bid = Number(orderBook?.bids?.[0]?.[0] ?? orderBook?.best_bid_price ?? 0);
  return {
    ask: Number.isFinite(ask) && ask > 0 ? ask : null,
    askSize: Number.isFinite(askSize) && askSize >= 0 ? askSize : null,
    bid: Number.isFinite(bid) && bid > 0 ? bid : null
  };
};

const extractMarkPrice = (orderBookPayload: any): number | null => {
  const orderBook = orderBookPayload?.result ?? orderBookPayload;
  const mark = Number(orderBook?.mark_price ?? 0);
  return Number.isFinite(mark) && mark > 0 ? mark : null;
};

const resolveDeribitSpot = async (connector: DeribitConnector): Promise<number> => {
  const spot = await connector.getIndexPrice("btc_usd");
  const indexPrice = Number((spot as any)?.result?.index_price ?? 0);
  if (!Number.isFinite(indexPrice) || indexPrice <= 0) {
    throw new Error("deribit_spot_unavailable");
  }
  return indexPrice;
};

export interface PilotVenueAdapter {
  quote(req: QuoteRequest): Promise<VenueQuote>;
  execute(quote: VenueQuote): Promise<VenueExecution>;
  getMark(params: { instrumentId: string; quantity: number }): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }>;
}

class MockFalconxAdapter implements PilotVenueAdapter {
  constructor(private quoteTtlMs: number) {}

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const premium = Number((req.protectedNotional * 0.01).toFixed(4));
    const quoteTs = nowIso();
    const expiresAt = new Date(Date.now() + this.quoteTtlMs).toISOString();
    return {
      venue: "mock_falconx",
      quoteId: randomUUID(),
      rfqId: randomUUID(),
      instrumentId: req.instrumentId,
      side: "buy",
      quantity: req.quantity,
      premium,
      expiresAt,
      quoteTs,
      details: { mode: "mock" }
    };
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    return {
      venue: "mock_falconx",
      status: "success",
      quoteId: quote.quoteId,
      rfqId: quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: quote.quantity,
      executionPrice: quote.premium / Math.max(quote.quantity, 0.000001),
      premium: quote.premium,
      executedAt: nowIso(),
      externalOrderId: `MOCK-ORD-${randomUUID()}`,
      externalExecutionId: `MOCK-EXE-${randomUUID()}`,
      details: { mode: "mock" }
    };
  }

  async getMark(params: { instrumentId: string; quantity: number }): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }> {
    const unitPrice = 1000;
    return {
      markPremium: Number((unitPrice * Math.max(params.quantity, 0)).toFixed(4)),
      unitPrice,
      source: "mock_static",
      asOf: nowIso(),
      details: { mode: "mock" }
    };
  }
}

class DeribitTestAdapter implements PilotVenueAdapter {
  constructor(
    private connector: DeribitConnector,
    private quoteTtlMs: number,
    private quotePolicy: DeribitQuotePolicy,
    private strikeSelectionMode: DeribitStrikeSelectionMode
  ) {}

  private resolveTargetOptionType(requestedInstrument: string): "put" | "call" {
    const normalized = String(requestedInstrument || "").toUpperCase();
    if (normalized.endsWith("-C")) return "call";
    return "put";
  }

  private async resolveQuoteInstrument(
    requestedInstrument: string,
    spot: number,
    targetTriggerPrice?: number
  ): Promise<{
    instrumentId: string;
    ask: number;
    askSize: number | null;
    optionType: "put" | "call";
    source: string;
  }> {
    const targetOptionType = this.resolveTargetOptionType(requestedInstrument);
    if (DERIBIT_OPTION_REGEX.test(requestedInstrument)) {
      const book = await this.connector.getOrderBook(requestedInstrument);
      const top = extractTopOfBook(book);
      if (top.ask && top.ask > 0) {
        return {
          instrumentId: requestedInstrument,
          ask: top.ask,
          askSize: top.askSize,
          optionType: targetOptionType,
          source: "requested_instrument_orderbook"
        };
      }
      const mark = extractMarkPrice(book);
      if (this.quotePolicy === "ask_or_mark_fallback" && mark && mark > 0) {
        return {
          instrumentId: requestedInstrument,
          ask: mark,
          askSize: top.askSize,
          optionType: targetOptionType,
          source: "requested_instrument_mark_fallback"
        };
      }
    }

    const instruments = (await this.connector.listInstruments("BTC")) as any;
    const list: any[] = Array.isArray(instruments?.result) ? instruments.result : [];
    const now = Date.now();
    const targetExpiry = now + 7 * 86400000;
    const targetStrike =
      this.strikeSelectionMode === "trigger_aligned" &&
      Number.isFinite(targetTriggerPrice) &&
      Number(targetTriggerPrice) > 0
        ? Number(targetTriggerPrice)
        : targetOptionType === "call"
          ? spot * 1.15
          : spot * 0.85;

    const candidates = list
      .filter((item) => String(item?.option_type || "").toLowerCase() === targetOptionType)
      .filter((item) => Number(item?.expiration_timestamp || 0) > now + 60 * 60 * 1000)
      .map((item) => ({
        instrumentId: String(item.instrument_name || ""),
        strike: Number(item.strike || parseDeribitStrike(String(item.instrument_name || "")) || 0),
        expiryTs: Number(item.expiration_timestamp || 0)
      }))
      .filter((item) => item.instrumentId && Number.isFinite(item.strike) && item.strike > 0)
      .sort((a, b) => {
        const scoreA =
          Math.abs(a.expiryTs - targetExpiry) / 86400000 + Math.abs(a.strike - targetStrike) / Math.max(spot, 1);
        const scoreB =
          Math.abs(b.expiryTs - targetExpiry) / 86400000 + Math.abs(b.strike - targetStrike) / Math.max(spot, 1);
        return scoreA - scoreB;
      })
      .slice(0, 25);

    for (const candidate of candidates) {
      const book = await this.connector.getOrderBook(candidate.instrumentId);
      const top = extractTopOfBook(book);
      if (top.ask && top.ask > 0) {
        return {
          instrumentId: candidate.instrumentId,
          ask: top.ask,
          askSize: top.askSize,
          optionType: targetOptionType,
          source: targetOptionType === "call" ? "auto_selected_deribit_call" : "auto_selected_deribit_put"
        };
      }
      const mark = extractMarkPrice(book);
      if (this.quotePolicy === "ask_or_mark_fallback" && mark && mark > 0) {
        return {
          instrumentId: candidate.instrumentId,
          ask: mark,
          askSize: top.askSize,
          optionType: targetOptionType,
          source:
            targetOptionType === "call"
              ? "auto_selected_deribit_call_mark_fallback"
              : "auto_selected_deribit_put_mark_fallback"
        };
      }
    }

    throw new Error("deribit_quote_unavailable");
  }

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const spot = await resolveDeribitSpot(this.connector);
    const resolved = await this.resolveQuoteInstrument(req.instrumentId, spot, req.triggerPrice);
    const premium = Number((resolved.ask * spot * req.quantity).toFixed(4));
    if (!Number.isFinite(premium) || premium <= 0) {
      throw new Error("deribit_quote_unavailable");
    }
    const quoteTs = nowIso();
    const expiresAt = new Date(Date.now() + this.quoteTtlMs).toISOString();
    return {
      venue: "deribit_test",
      quoteId: randomUUID(),
      rfqId: null,
      instrumentId: resolved.instrumentId,
      side: "buy",
      quantity: req.quantity,
      premium,
      expiresAt,
      quoteTs,
      details: {
        source: resolved.source,
        optionType: resolved.optionType,
        pricing: "live_orderbook",
        askPriceBtc: resolved.ask,
        askSize: resolved.askSize,
        spotPriceUsd: spot
      }
    };
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    const order = (await this.connector.placeOrder({
      instrument: quote.instrumentId,
      amount: quote.quantity,
      side: "buy",
      type: "market"
    })) as any;
    const status =
      order?.status === "paper_filled" || order?.status === "filled" || order?.status === "ok"
        ? "success"
        : "failure";
    const rawFilledAmount = Number(order?.filledAmount ?? order?.amount ?? quote.quantity);
    const executedQuantity =
      Number.isFinite(rawFilledAmount) && rawFilledAmount > 0 ? rawFilledAmount : quote.quantity;
    const executedPremium =
      quote.quantity > 0
        ? Number(((quote.premium * executedQuantity) / quote.quantity).toFixed(10))
        : quote.premium;
    return {
      venue: "deribit_test",
      status,
      quoteId: quote.quoteId,
      rfqId: quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: executedQuantity,
      executionPrice: Number(order?.fillPrice ?? 0),
      premium: executedPremium,
      executedAt: nowIso(),
      externalOrderId: String(order?.id || `DERIBIT-ORD-${randomUUID()}`),
      externalExecutionId: String(order?.id || `DERIBIT-EXE-${randomUUID()}`),
      details: {
        raw: order,
        requestedQuantity: quote.quantity,
        executedQuantity
      }
    };
  }

  async getMark(params: { instrumentId: string; quantity: number }): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }> {
    const [orderBookPayload, spot] = await Promise.all([
      this.connector.getOrderBook(params.instrumentId),
      resolveDeribitSpot(this.connector)
    ]);
    const orderBook = orderBookPayload?.result ?? orderBookPayload;
    const top = extractTopOfBook(orderBookPayload);
    const markBtc = Number(orderBook?.mark_price ?? 0);
    const unitPrice =
      Number.isFinite(markBtc) && markBtc > 0
        ? markBtc * spot
        : top.ask && top.bid
          ? ((top.ask + top.bid) / 2) * spot
          : top.ask
            ? top.ask * spot
            : top.bid
              ? top.bid * spot
              : NaN;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error("mark_unavailable");
    }
    const quantity = Math.max(0, Number(params.quantity || 0));
    return {
      markPremium: Number((unitPrice * quantity).toFixed(4)),
      unitPrice: Number(unitPrice.toFixed(4)),
      source: Number.isFinite(markBtc) && markBtc > 0 ? "deribit_mark_price" : "deribit_top_of_book",
      asOf: nowIso(),
      details: {
        markPriceBtc: Number.isFinite(markBtc) ? markBtc : null,
        askPriceBtc: top.ask,
        bidPriceBtc: top.bid,
        spotPriceUsd: spot
      }
    };
  }
}

class FalconxAdapter implements PilotVenueAdapter {
  constructor(private cfg: FalconxConfig) {}

  async quote(req: QuoteRequest): Promise<VenueQuote> {
    const [baseToken, quoteTokenRaw] = req.marketId.split("-");
    const quoteToken = quoteTokenRaw === "USD" || !quoteTokenRaw ? "USDC" : quoteTokenRaw;
    const payload = {
      token_pair: {
        base_token: baseToken,
        quote_token: quoteToken
      },
      quantity: req.quantity,
      structure: [
        {
          side: req.side,
          symbol: req.instrumentId,
          weight: 1
        }
      ],
      client_order_id: req.clientOrderId || randomUUID()
    };
    const response = await falconxRequest(this.cfg, "/v3/derivatives/option/quote", "POST", payload);
    if (String(response?.status || "").toLowerCase() !== "success") {
      throw new Error(`falconx_quote_failed:${response?.error?.code || "unknown"}`);
    }
    return {
      venue: "falconx",
      quoteId: String(response.fx_quote_id),
      rfqId: response.rfq_id ? String(response.rfq_id) : null,
      instrumentId: req.instrumentId,
      side: "buy",
      quantity: Number(response.quantity ?? req.quantity),
      premium: Number(response.ask_price?.value ?? 0),
      expiresAt: String(response.t_expiry || nowIso()),
      quoteTs: String(response.t_quote || nowIso()),
      details: response
    };
  }

  async execute(quote: VenueQuote): Promise<VenueExecution> {
    const response = await falconxRequest(
      this.cfg,
      "/v3/derivatives/option/quote/execute",
      "POST",
      { fx_quote_id: quote.quoteId }
    );
    if (String(response?.status || "").toLowerCase() !== "success") {
      throw new Error(`falconx_execute_failed:${response?.error?.code || "unknown"}`);
    }
    return {
      venue: "falconx",
      status: "success",
      quoteId: String(response.fx_quote_id || quote.quoteId),
      rfqId: response.rfq_id ? String(response.rfq_id) : quote.rfqId ?? null,
      instrumentId: quote.instrumentId,
      side: "buy",
      quantity: Number(response.quantity ?? quote.quantity),
      executionPrice: Number(response.executed_price ?? 0),
      premium: Number(response.executed_price ?? quote.premium),
      executedAt: String(response.t_execute || nowIso()),
      externalOrderId: String(response.fx_quote_id || quote.quoteId),
      externalExecutionId: String(response.rfq_id || quote.rfqId || randomUUID()),
      details: response
    };
  }

  async getMark(): Promise<{
    markPremium: number;
    unitPrice: number;
    source: string;
    asOf: string;
    details?: Record<string, unknown>;
  }> {
    throw new Error("mark_unavailable");
  }
}

export const createPilotVenueAdapter = (params: {
  mode: PilotVenueMode;
  falconx: FalconxConfig;
  deribit: DeribitConnector;
  quoteTtlMs?: number;
  deribitQuotePolicy?: DeribitQuotePolicy;
  deribitStrikeSelectionMode?: DeribitStrikeSelectionMode;
}): PilotVenueAdapter => {
  const quoteTtlMs = Math.max(5_000, Number(params.quoteTtlMs || 30_000));
  const deribitQuotePolicy: DeribitQuotePolicy =
    params.deribitQuotePolicy === "ask_only" ? "ask_only" : "ask_or_mark_fallback";
  const deribitStrikeSelectionMode: DeribitStrikeSelectionMode =
    params.deribitStrikeSelectionMode === "trigger_aligned" ? "trigger_aligned" : "legacy";
  if (params.mode === "falconx") return new FalconxAdapter(params.falconx);
  if (params.mode === "deribit_test") {
    return new DeribitTestAdapter(
      params.deribit,
      quoteTtlMs,
      deribitQuotePolicy,
      deribitStrikeSelectionMode
    );
  }
  return new MockFalconxAdapter(quoteTtlMs);
};

export const mapVenueFailureReason = (error: unknown): string => {
  const message = String((error as any)?.message || "venue_error");
  if (message.includes("QUOTE_EXPIRED")) return "quote_expired";
  if (message.includes("INVALID_QUOTE_ID")) return "invalid_quote_id";
  if (message.includes("COOLDOWN")) return "execution_cooldown";
  if (message.includes("INSUFFICIENT")) return "insufficient_balance";
  return "venue_error";
};

