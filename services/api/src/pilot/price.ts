import Decimal from "decimal.js";
import type { PriceSource } from "./types";

export type PriceSnapshotInput = {
  marketId: string;
  now: Date;
  expiryAt?: Date;
  requestId: string;
  endpointVersion: string;
};

export type PriceSnapshotOutput = {
  price: Decimal;
  priceTimestamp: string;
  marketId: string;
  priceSource: PriceSource;
  priceSourceDetail: string;
  endpointVersion: string;
  requestId: string;
};

export type PriceChainConfig = {
  primaryUrl: string;
  fallbackUrl: string;
  primaryTimeoutMs: number;
  fallbackTimeoutMs: number;
  freshnessMaxMs: number;
  requestRetryAttempts?: number;
  requestRetryDelayMs?: number;
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const parseJsonPayload = async (response: any): Promise<any> => {
  if (typeof response?.text === "function") {
    const raw = await response.text();
    if (!raw || !String(raw).trim()) {
      throw new Error("empty_body");
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("invalid_json");
    }
  }
  if (typeof response?.json === "function") {
    try {
      return await response.json();
    } catch {
      throw new Error("invalid_json");
    }
  }
  throw new Error("missing_json_body");
};

const fetchJsonWithTimeout = async (url: string, timeoutMs: number): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`http_${res.status}`);
    }
    return await parseJsonPayload(res);
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error("timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const fetchJsonWithRetries = async (params: {
  url: string;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
}): Promise<any> => {
  const attempts = Math.max(1, Math.floor(params.retryAttempts));
  let lastError = "request_failed";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJsonWithTimeout(params.url, params.timeoutMs);
    } catch (error: any) {
      lastError = String(error?.message || "request_failed");
      if (attempt < attempts) {
        await sleep(params.retryDelayMs);
      }
    }
  }
  throw new Error(lastError);
};

const normalizeTimestampMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 10_000_000_000) return Math.floor(value);
    return Math.floor(value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) {
      if (asNum > 10_000_000_000) return Math.floor(asNum);
      return Math.floor(asNum * 1000);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const extractPrimary = (payload: any): {
  marketId: string | null;
  price: number | null;
  timestampMs: number | null;
} => {
  const marketId =
    payload?.market_id ??
    payload?.marketId ??
    payload?.market ??
    payload?.product_id ??
    payload?.symbol ??
    payload?.pair ??
    payload?.result?.market_id ??
    payload?.result?.market ??
    null;
  const price =
    Number(
      payload?.oraclePrice ??
        payload?.oracle_price ??
        payload?.indexPrice ??
        payload?.index_price ??
        payload?.price ??
        payload?.result?.index_price ??
        payload?.result?.mark_price ??
        payload?.result?.last_price ??
        payload?.result?.price
    );
  const timestampMs =
    normalizeTimestampMs(
      payload?.timestamp ??
        payload?.time ??
        payload?.price_timestamp ??
        payload?.updatedAt ??
        payload?.updated_at ??
        payload?.result?.timestamp
    ) ?? null;
  return {
    marketId: typeof marketId === "string" ? marketId : null,
    price: Number.isFinite(price) ? price : null,
    timestampMs
  };
};

const extractFallback = (payload: any): {
  marketId: string | null;
  price: number | null;
  timestampMs: number | null;
} => {
  const marketId =
    payload?.market_id ??
    payload?.marketId ??
    payload?.symbol ??
    payload?.pair ??
    payload?.result?.market_id ??
    null;
  const price = Number(
    payload?.price ??
      payload?.value ??
      payload?.result?.price ??
      payload?.result?.index_price ??
      payload?.result?.last_price
  );
  const timestampMs =
    normalizeTimestampMs(
      payload?.timestamp ??
        payload?.time ??
        payload?.result?.timestamp ??
        payload?.updated_at ??
        payload?.updatedAt
    ) ?? null;
  return {
    marketId: typeof marketId === "string" ? marketId : null,
    price: Number.isFinite(price) ? price : null,
    timestampMs
  };
};

const validate = (params: {
  expectedMarket: string;
  fetchedMarket: string | null;
  price: number | null;
  timestampMs: number | null;
  nowMs: number;
  freshnessMaxMs: number;
  expiryAtMs?: number;
}): { ok: boolean; reason?: string } => {
  if (!params.fetchedMarket) return { ok: false, reason: "missing_market_id" };
  if (params.fetchedMarket !== params.expectedMarket) return { ok: false, reason: "market_mismatch" };
  if (!Number.isFinite(params.price) || (params.price as number) <= 0) {
    return { ok: false, reason: "invalid_price" };
  }
  if (!params.timestampMs) return { ok: false, reason: "missing_timestamp" };
  if (Math.abs(params.nowMs - params.timestampMs) > params.freshnessMaxMs) {
    return { ok: false, reason: "stale_timestamp" };
  }
  if (params.expiryAtMs !== undefined && params.timestampMs < params.expiryAtMs) {
    return { ok: false, reason: "before_expiry_timestamp" };
  }
  return { ok: true };
};

export const resolvePriceSnapshot = async (
  config: PriceChainConfig,
  input: PriceSnapshotInput
): Promise<PriceSnapshotOutput> => {
  const nowMs = input.now.getTime();
  const expiryAtMs = input.expiryAt ? input.expiryAt.getTime() : undefined;
  const retryAttempts = Number.isFinite(config.requestRetryAttempts)
    ? Number(config.requestRetryAttempts)
    : 2;
  const retryDelayMs = Number.isFinite(config.requestRetryDelayMs)
    ? Number(config.requestRetryDelayMs)
    : 120;
  let primaryError = "unknown";
  try {
    const primaryPayload = await fetchJsonWithRetries({
      url: config.primaryUrl,
      timeoutMs: config.primaryTimeoutMs,
      retryAttempts,
      retryDelayMs
    });
    const extracted = extractPrimary(primaryPayload);
    const primaryMarket = extracted.marketId || input.marketId;
    const verdict = validate({
      expectedMarket: input.marketId,
      fetchedMarket: primaryMarket,
      price: extracted.price,
      timestampMs: extracted.timestampMs,
      nowMs,
      freshnessMaxMs: config.freshnessMaxMs,
      expiryAtMs
    });
    if (verdict.ok) {
      return {
        price: new Decimal(extracted.price as number),
        priceTimestamp: new Date(extracted.timestampMs as number).toISOString(),
        marketId: input.marketId,
        priceSource: "reference_oracle",
        priceSourceDetail: primaryMarket === extracted.marketId ? "reference_oracle_api" : "reference_oracle_inferred_market",
        endpointVersion: input.endpointVersion,
        requestId: input.requestId
      };
    }
    primaryError = verdict.reason || "invalid_primary_payload";
  } catch (error: any) {
    primaryError = error?.message || "primary_request_failed";
  }

  if (!config.fallbackUrl) {
    throw new Error(`price_unavailable:${primaryError}:fallback_disabled`);
  }

  try {
    const fallbackPayload = await fetchJsonWithRetries({
      url: config.fallbackUrl,
      timeoutMs: config.fallbackTimeoutMs,
      retryAttempts,
      retryDelayMs
    });
    const fallbackExtracted = extractFallback(fallbackPayload);
    const fallbackMarket = fallbackExtracted.marketId || input.marketId;
    const fallbackVerdict = validate({
      expectedMarket: input.marketId,
      fetchedMarket: fallbackMarket,
      price: fallbackExtracted.price,
      timestampMs: fallbackExtracted.timestampMs,
      nowMs,
      freshnessMaxMs: config.freshnessMaxMs,
      expiryAtMs
    });
    if (!fallbackVerdict.ok) {
      throw new Error(fallbackVerdict.reason || "invalid_fallback_payload");
    }
    return {
      price: new Decimal(fallbackExtracted.price as number),
      priceTimestamp: new Date(fallbackExtracted.timestampMs as number).toISOString(),
      marketId: input.marketId,
      priceSource: "fallback_oracle",
      priceSourceDetail: "fallback_oracle_api",
      endpointVersion: input.endpointVersion,
      requestId: input.requestId
    };
  } catch (error: any) {
    throw new Error(`price_unavailable:${primaryError}:${error?.message || "fallback_request_failed"}`);
  }
};

