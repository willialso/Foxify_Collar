/**
 * Bybit Options Orderbook Adapter
 * Simple, production-ready integration for dual-venue pricing
 *
 * Requirements: Server must be in allowed region (Singapore/EU) or use VPN
 * No workarounds or hacks - just clean API calls
 */

// MAINNET - requires VPN to Singapore for access
const BYBIT_BASE_URL = "https://api.bybit.com/v5";
const BYBIT_TIMEOUT_MS = 5000;
const BYBIT_STRIKES_CACHE_TTL_MS = 60000;

console.log("[Bybit] ⚠️  Using MAINNET endpoint (read-only, public data)");
console.log("[Bybit] Timeout set to 5s (optimized for performance)");

const bybitStrikesCache = new Map<string, BybitStrikesCacheEntry>();

export interface BybitOrderbookData {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  spread: number;
  venue: string;
  timestamp: number;
}

export interface BybitStrikeSnapshot {
  strike: number;
  ask: number;
  bid: number;
  askSize: number;
  bidSize: number;
  spreadPct: number;
  symbol: string;
}

type BybitStrikesCacheEntry = {
  expiresAt: number;
  strikes: BybitStrikeSnapshot[];
};

/**
 * Format Bybit instrument name
 * Example: BTC, Feb 28 2026, $100000 call -> "BTC-28FEB26-100000-C"
 */
export function formatBybitInstrument(
  asset: string,
  expiry: Date,
  strike: number,
  optionType: "C" | "P"
): string {
  const day = expiry.getUTCDate().toString().padStart(2, "0");
  const monthNames = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC"
  ];
  const month = monthNames[expiry.getUTCMonth()];
  const year = expiry.getUTCFullYear().toString().slice(2);
  return `${asset}-${day}${month}${year}-${strike}-${optionType}-USDT`;
}

export function formatBybitExpiryTag(expiry: Date): string {
  const day = expiry.getUTCDate().toString().padStart(2, "0");
  const monthNames = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC"
  ];
  const month = monthNames[expiry.getUTCMonth()];
  const year = expiry.getUTCFullYear().toString().slice(2);
  return `${day}${month}${year}`;
}

export async function getBybitAvailableStrikes(
  asset: string,
  expiry: Date,
  optionType: "C" | "P"
): Promise<BybitStrikeSnapshot[]> {
  console.log(`[Bybit] Fetching available strikes for ${asset} ${optionType}`);
  const expiryTag = formatBybitExpiryTag(expiry);
  const cacheKey = `${asset}-${expiryTag}-${optionType}`;
  const now = Date.now();
  const cached = bybitStrikesCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.strikes;
  }
  const url = `${BYBIT_BASE_URL}/market/tickers?category=option&baseCoin=${asset}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BYBIT_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Content-Type": "application/json" }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[Bybit] Strike list HTTP ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (data?.retCode !== 0) {
      console.log(`[Bybit] Strike list API error ${data?.retCode}: ${data?.retMsg}`);
      return [];
    }

    const list = Array.isArray(data?.result?.list) ? data.result.list : [];
    if (!list.length) {
      console.log("[Bybit] No strikes returned");
      return [];
    }

    const matches = list.filter((item: any) => {
      const symbol = String(item?.symbol || "");
      return (
        symbol.includes(expiryTag) &&
        (symbol.endsWith(`-${optionType}`) || symbol.endsWith(`-${optionType}-USDT`))
      );
    });
    if (!matches.length) {
      const samples = list
        .slice(0, 5)
        .map((item: any) => String(item?.symbol || ""))
        .filter(Boolean);
      console.log(
        `[Bybit] No matches for ${expiryTag} (${optionType}). Sample symbols: ${samples.join(", ")}`
      );
    }

    const strikes: BybitStrikeSnapshot[] = matches
      .map((item: any) => {
        const symbol = String(item?.symbol || "");
        const parts = symbol.split("-");
        const strike = Number(parts[2]);
        const bid = Number(item?.bid1Price || 0);
        const ask = Number(item?.ask1Price || 0);
        const bidSize = Number(item?.bid1Size || 0);
        const askSize = Number(item?.ask1Size || 0);
        if (!Number.isFinite(strike) || strike <= 0) return null;
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
        const spreadPct = bid > 0 ? ((ask - bid) / bid) * 100 : 0;
        return { strike, bid, ask, bidSize, askSize, spreadPct, symbol };
      })
      .filter(Boolean) as BybitStrikeSnapshot[];

    strikes.sort((a, b) => a.strike - b.strike);
    console.log(
      `[Bybit] Found ${strikes.length} liquid strikes for ${expiryTag} (${optionType})`
    );
    bybitStrikesCache.set(cacheKey, {
      strikes,
      expiresAt: now + BYBIT_STRIKES_CACHE_TTL_MS
    });
    return strikes;
  } catch (error: any) {
    if (error?.name === "AbortError") {
      console.log(`[Bybit] Strike list timeout after ${BYBIT_TIMEOUT_MS}ms`);
    } else {
      console.log(`[Bybit] Strike list error: ${error?.message ?? "unknown error"}`);
    }
    return [];
  }
}

/**
 * Get Bybit orderbook for specific option
 * Returns best bid/ask or null if unavailable/error
 */
export async function getBybitOrderbook(
  asset: string,
  strike: number,
  expiry: Date,
  optionType: "C" | "P"
): Promise<BybitOrderbookData | null> {
  try {
    const instrument = formatBybitInstrument(asset, expiry, strike, optionType);
    const url = `${BYBIT_BASE_URL}/market/orderbook?category=option&symbol=${instrument}&limit=1`;

    console.log(`[Bybit] Fetching orderbook: ${instrument}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BYBIT_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Content-Type": "application/json" }
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[Bybit] HTTP ${response.status} for ${instrument}`);
      return null;
    }

    const data = await response.json();
    if (data?.retCode !== 0) {
      console.log(`[Bybit] API error ${data?.retCode}: ${data?.retMsg}`);
      return null;
    }

    const orderbook = data?.result;
    const bids = Array.isArray(orderbook?.b) ? orderbook.b : [];
    const asks = Array.isArray(orderbook?.a) ? orderbook.a : [];
    if (!bids.length || !asks.length) {
      console.log(`[Bybit] Empty orderbook for ${instrument} (may not exist)`);
      return null;
    }

    const bid = parseFloat(bids[0][0]);
    const bidSize = parseFloat(bids[0][1]);
    const ask = parseFloat(asks[0][0]);
    const askSize = parseFloat(asks[0][1]);

    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
      console.log(`[Bybit] Invalid prices: bid=${bid}, ask=${ask}`);
      return null;
    }

    const spread = ((ask - bid) / bid) * 100;

    console.log(`[Bybit] ✅ ${instrument}: ask=$${ask}, bid=$${bid}, spread=${spread.toFixed(2)}%`);

    return {
      bid,
      ask,
      bidSize: Number.isFinite(bidSize) ? bidSize : 0,
      askSize: Number.isFinite(askSize) ? askSize : 0,
      spread,
      venue: "Bybit",
      timestamp: Date.now()
    };
  } catch (error: any) {
    if (error?.name === "AbortError") {
      console.log(`[Bybit] Timeout after ${BYBIT_TIMEOUT_MS}ms`);
    } else {
      console.log(`[Bybit] Error: ${error?.message ?? "unknown error"}`);
    }
    return null;
  }
}

/**
 * Get BTC spot price from Bybit (for reference/validation)
 * Not critical - can use spot price from request if this fails
 */
export async function getBybitSpotPrice(asset: string = "BTC"): Promise<number | null> {
  try {
    const url = `${BYBIT_BASE_URL}/market/tickers?category=spot&symbol=${asset}USDT`;
    const response = await fetch(url, { headers: { "Content-Type": "application/json" } });
    if (!response.ok) {
      console.log(`[Bybit] Spot price HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    const list = data?.result?.list;
    if (!Array.isArray(list) || !list.length) {
      console.log(`[Bybit] Spot price API error: ${data?.retMsg ?? "invalid response"}`);
      return null;
    }
    const spotPrice = parseFloat(list[0]?.lastPrice);
    if (spotPrice > 0) {
      console.log(`[Bybit] Spot price: $${spotPrice.toFixed(2)}`);
      return spotPrice;
    }
    return null;
  } catch (error: any) {
    console.log(`[Bybit] Spot price error: ${error?.message ?? "unknown error"}`);
    return null;
  }
}

export async function getBybitAtmIv(asset: string = "BTC"): Promise<number | null> {
  try {
    const url = `${BYBIT_BASE_URL}/market/tickers?category=option&baseCoin=${asset}`;
    const response = await fetch(url, { headers: { "Content-Type": "application/json" } });
    if (!response.ok) {
      console.log(`[Bybit] ATM IV HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (data?.retCode !== 0) {
      console.log(`[Bybit] ATM IV API error ${data?.retCode}: ${data?.retMsg}`);
      return null;
    }
    const list = Array.isArray(data?.result?.list) ? data.result.list : [];
    if (!list.length) return null;

    const spot = await getBybitSpotPrice(asset);
    const now = Date.now();
    const parsed = list
      .map((item: any) => {
        const symbol = String(item?.symbol || "");
        const parts = symbol.split("-");
        if (parts.length < 4) return null;
        const expiryTag = parts[1];
        const strike = Number(parts[2]);
        const optionType = parts[3]?.toUpperCase();
        if (!Number.isFinite(strike)) return null;
        const ivRaw =
          Number(item?.markIv ?? item?.markIV ?? item?.mark_iv ?? item?.iv ?? item?.impliedVolatility ?? 0);
        if (!Number.isFinite(ivRaw) || ivRaw <= 0) return null;
        const expiryDate = parseBybitExpiryTag(expiryTag);
        if (!expiryDate) return null;
        return {
          strike,
          optionType,
          expiryDate,
          expiryMs: expiryDate.getTime(),
          iv: ivRaw
        };
      })
      .filter(Boolean) as Array<{
      strike: number;
      optionType: string;
      expiryDate: Date;
      expiryMs: number;
      iv: number;
    }>;

    if (!parsed.length) return null;

    const future = parsed.filter((entry) => entry.expiryMs > now);
    const pool = future.length ? future : parsed;
    pool.sort((a, b) => a.expiryMs - b.expiryMs);
    const nearestExpiryMs = pool[0].expiryMs;
    const sameExpiry = pool.filter((entry) => entry.expiryMs === nearestExpiryMs);
    const strikesPool = sameExpiry.length ? sameExpiry : pool;
    let candidate = strikesPool[0];
    if (spot && Number.isFinite(spot)) {
      candidate = strikesPool.reduce((acc, entry) =>
        Math.abs(entry.strike - spot) < Math.abs(acc.strike - spot) ? entry : acc
      );
    }
    let iv = candidate.iv;
    if (iv > 3) iv = iv / 100;
    return iv;
  } catch (error: any) {
    console.log(`[Bybit] ATM IV error: ${error?.message ?? "unknown error"}`);
    return null;
  }
}

export function parseBybitExpiryTag(expiryTag: string): Date | null {
  const match = expiryTag.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const monthStr = match[2];
  const year = Number(match[3]);
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC"
  ];
  const monthIndex = months.indexOf(monthStr);
  if (monthIndex === -1) return null;
  const fullYear = 2000 + year;
  const date = new Date(Date.UTC(fullYear, monthIndex, day, 8, 0, 0, 0));
  return date;
}
