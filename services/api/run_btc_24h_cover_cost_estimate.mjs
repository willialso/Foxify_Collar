import Decimal from "decimal.js";

/**
 * Internal analysis script (non-production):
 * - Uses existing /put/quote pricing path to estimate 24h BTC downside cover cost.
 * - Does NOT add/modify any API routes or handlers.
 * - Assumes a long BTC/USD position with leverage=1 and put protection.
 *
 * Scenario:
 * - Notional: 1,000,000 USD
 * - Max loss / cover amount: 20,000 USD (2%)
 * - Horizon: 24h (targetDays=1)
 *
 * Optional historical mode:
 * - --history-days=N replays the same quote path against daily historical BTC closes.
 * - This is a rough replay because current option books/liquidity are still used by /put/quote.
 * - Intended only for internal ballpark analysis.
 */

const DEFAULT_API_BASE = process.env.API_BASE || "http://127.0.0.1:4100";
const DERIBIT_PUBLIC_BASE = "https://www.deribit.com/api/v2";

const NOTIONAL_USD = new Decimal(1_000_000);
const MAX_LOSS_USD = new Decimal(20_000);
const TARGET_DAYS = 1;
const LEVERAGE = 1;
const SIDE = "long";
const ASSET = "BTC";

const drawdownFloorPct = MAX_LOSS_USD.div(NOTIONAL_USD);

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  return hit.slice(prefix.length);
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed ${res.status}: ${text}`);
  }
  return res.json();
}

async function getLatestSpotFromApi(apiBase) {
  const data = await fetchJson(`${apiBase}/pricing/btc`);
  const spotRaw = data?.result?.index_price;
  const spot = new Decimal(spotRaw ?? 0);
  if (!spot.isFinite() || spot.lte(0)) {
    throw new Error(`Invalid spot from /pricing/btc: ${JSON.stringify(data)}`);
  }
  return spot;
}

function buildQuotePayload(spotPrice) {
  const positionSize = NOTIONAL_USD.div(spotPrice).div(LEVERAGE);
  return {
    tierName: "Pro (Gold)",
    asset: ASSET,
    spotPrice: Number(spotPrice.toFixed(8)),
    drawdownFloorPct: Number(drawdownFloorPct.toFixed(8)),
    fixedPriceUsdc: 0,
    positionSize: Number(positionSize.toFixed(8)),
    contractSize: 1,
    leverage: LEVERAGE,
    side: SIDE,
    targetDays: TARGET_DAYS,
    allowPremiumPassThrough: true,
    // Internal cache-bust for reproducible ad-hoc analysis on latest market state.
    _cacheBust: true
  };
}

function extractPremiumFromQuote(quoteResponse) {
  const premiumRaw = quoteResponse?.rollEstimatedPremiumUsdc ?? quoteResponse?.premiumUsdc ?? 0;
  const premiumUsdc = new Decimal(premiumRaw);
  if (!premiumUsdc.isFinite() || premiumUsdc.lt(0)) {
    throw new Error(`Invalid premium in quote response: ${JSON.stringify(quoteResponse)}`);
  }
  return premiumUsdc;
}

function computeBps(premiumUsdc) {
  return premiumUsdc.div(NOTIONAL_USD).mul(10_000);
}

async function listDeribitInstruments(asset = "BTC") {
  const data = await fetchJson(
    `${DERIBIT_PUBLIC_BASE}/public/get_instruments?currency=${asset}&kind=option&expired=false`
  );
  return Array.isArray(data?.result) ? data.result : [];
}

async function getDeribitOrderBook(instrumentName) {
  const data = await fetchJson(
    `${DERIBIT_PUBLIC_BASE}/public/get_order_book?instrument_name=${encodeURIComponent(instrumentName)}`
  );
  return data?.result ?? null;
}

function pickClosestExpiryTag(instruments, targetDays) {
  const now = Date.now();
  const targetMs = targetDays * 24 * 60 * 60 * 1000;
  let bestTag = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const inst of instruments) {
    if (!inst?.expiration_timestamp || inst?.option_type !== "put") continue;
    const diff = Math.abs(inst.expiration_timestamp - now - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestTag = String(inst?.instrument_name || "").split("-")[1] ?? null;
    }
  }
  return bestTag;
}

async function deribitDirectFallbackQuote(spotPrice) {
  const instruments = await listDeribitInstruments(ASSET);
  if (!instruments.length) {
    return { status: "no_quote", reason: "no_deribit_instruments" };
  }
  const expiryTag = pickClosestExpiryTag(instruments, TARGET_DAYS);
  if (!expiryTag) {
    return { status: "no_quote", reason: "no_deribit_expiry" };
  }

  const targetStrike = spotPrice.mul(new Decimal(1).minus(drawdownFloorPct));
  const candidates = instruments
    .filter((inst) => inst?.option_type === "put" && String(inst?.instrument_name || "").includes(expiryTag))
    .map((inst) => ({
      instrument: inst.instrument_name,
      strike: new Decimal(inst.strike || 0),
      distance: new Decimal(inst.strike || 0).minus(targetStrike).abs()
    }))
    .sort((a, b) => a.distance.comparedTo(b.distance))
    .slice(0, 10);

  if (!candidates.length) {
    return { status: "no_quote", reason: "no_deribit_strike_candidates", expiryTag };
  }

  const positionSize = NOTIONAL_USD.div(spotPrice).div(LEVERAGE);
  for (const candidate of candidates) {
    const book = await getDeribitOrderBook(candidate.instrument);
    const askRaw = book?.asks?.[0]?.[0] ?? null;
    if (askRaw === null || askRaw === undefined) continue;
    const ask = new Decimal(askRaw);
    if (!ask.isFinite() || ask.lte(0)) continue;
    const premiumUsdc = ask.mul(spotPrice).mul(positionSize);
    return {
      status: "ok",
      pricingPath: "deribit_direct_fallback",
      instrument: candidate.instrument,
      expiryTag,
      strike: candidate.strike.toNumber(),
      premiumUsdc
    };
  }

  return { status: "no_quote", reason: "no_deribit_orderbook_asks", expiryTag };
}

async function quoteForSpot(apiBase, spotPrice) {
  const payload = buildQuotePayload(spotPrice);
  const quoteResponse = await fetchJson(`${apiBase}/put/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const quoteStatus = String(quoteResponse?.status || "").toLowerCase();
  const quotePremiumRaw = quoteResponse?.rollEstimatedPremiumUsdc ?? quoteResponse?.premiumUsdc ?? null;
  const quotePremium = quotePremiumRaw === null ? null : new Decimal(quotePremiumRaw);
  const quoteHasPremium = quotePremium && quotePremium.isFinite() && quotePremium.gt(0);

  if (quoteStatus !== "no_quote" && quoteHasPremium) {
    const premiumUsdc = extractPremiumFromQuote(quoteResponse);
    return {
      payload,
      quoteResponse,
      premiumUsdc,
      premiumBps: computeBps(premiumUsdc),
      pricingPath: "put_quote"
    };
  }

  const fallback = await deribitDirectFallbackQuote(spotPrice);
  if (fallback.status === "ok") {
    return {
      payload,
      quoteResponse,
      premiumUsdc: fallback.premiumUsdc,
      premiumBps: computeBps(fallback.premiumUsdc),
      pricingPath: fallback.pricingPath,
      fallback
    };
  }

  const premiumUsdc = new Decimal(0);
  return {
    payload,
    quoteResponse,
    premiumUsdc,
    premiumBps: computeBps(premiumUsdc),
    pricingPath: "unavailable",
    fallback
  };
}

async function getHistoricalDailyCloses(days) {
  if (!Number.isFinite(days) || days <= 0) return [];
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const url =
    `${DERIBIT_PUBLIC_BASE}/public/get_tradingview_chart_data` +
    `?instrument_name=BTC-PERPETUAL&start_timestamp=${start}&end_timestamp=${now}&resolution=1D`;
  const data = await fetchJson(url);
  const result = data?.result || {};
  const ticks = Array.isArray(result.ticks) ? result.ticks : [];
  const closes = Array.isArray(result.close) ? result.close : [];
  const points = [];
  for (let i = 0; i < Math.min(ticks.length, closes.length); i += 1) {
    const close = new Decimal(closes[i] ?? 0);
    if (!close.isFinite() || close.lte(0)) continue;
    points.push({ ts: Number(ticks[i]), close });
  }
  return points;
}

function summarize(values) {
  if (!values.length) return null;
  let min = values[0];
  let max = values[0];
  let sum = new Decimal(0);
  for (const v of values) {
    if (v.lt(min)) min = v;
    if (v.gt(max)) max = v;
    sum = sum.plus(v);
  }
  return { min, max, avg: sum.div(values.length) };
}

async function run() {
  const apiBase = getArg("api-base", DEFAULT_API_BASE);
  const historyDays = Number(getArg("history-days", "0"));

  console.log("=== BTC 24h Cover Cost Estimate (Internal) ===");
  console.log(
    JSON.stringify(
      {
        apiBase,
        instrument: "BTC/USD",
        notionalUsd: Number(NOTIONAL_USD.toFixed(2)),
        maxLossUsd: Number(MAX_LOSS_USD.toFixed(2)),
        drawdownFloorPct: Number(drawdownFloorPct.mul(100).toFixed(4)),
        targetDays: TARGET_DAYS,
        side: SIDE,
        leverage: LEVERAGE
      },
      null,
      2
    )
  );

  const latestSpot = await getLatestSpotFromApi(apiBase);
  const latestQuote = await quoteForSpot(apiBase, latestSpot);

  console.log("\n--- Latest 24h quote ---");
  console.log(
    JSON.stringify(
      {
        spotUsd: Number(latestSpot.toFixed(2)),
        status: latestQuote.quoteResponse?.status ?? "unknown",
        pricingPath: latestQuote.pricingPath,
        expiryTag: latestQuote.quoteResponse?.expiryTag ?? null,
        targetDaysUsed: latestQuote.quoteResponse?.targetDays ?? null,
        instrument:
          latestQuote.quoteResponse?.instrument ?? latestQuote.fallback?.instrument ?? null,
        premiumUsd: Number(latestQuote.premiumUsdc.toFixed(2)),
        premiumBpsOfNotional: Number(latestQuote.premiumBps.toFixed(4)),
        quoteId: latestQuote.quoteResponse?.quoteId ?? null,
        noQuoteReason: latestQuote.quoteResponse?.reason ?? latestQuote.fallback?.reason ?? null
      },
      null,
      2
    )
  );

  if (historyDays > 0) {
    const points = await getHistoricalDailyCloses(historyDays);
    if (!points.length) {
      console.log(`\nNo historical BTC daily closes found for ${historyDays}d window.`);
      return;
    }

    const samples = [];
    for (const point of points) {
      try {
        const priced = await quoteForSpot(apiBase, point.close);
        samples.push({
          ts: new Date(point.ts).toISOString(),
          spotUsd: Number(point.close.toFixed(2)),
          status: priced.quoteResponse?.status ?? "unknown",
          premiumUsd: priced.premiumUsdc,
          premiumBps: priced.premiumBps
        });
      } catch (error) {
        samples.push({
          ts: new Date(point.ts).toISOString(),
          spotUsd: Number(point.close.toFixed(2)),
          status: "error",
          error: String(error?.message || error)
        });
      }
    }

    const okSamples = samples.filter((s) => s.status !== "error" && s.premiumUsd instanceof Decimal);
    const premiums = okSamples.map((s) => s.premiumUsd);
    const bpsValues = okSamples.map((s) => s.premiumBps);
    const premiumStats = summarize(premiums);
    const bpsStats = summarize(bpsValues);

    console.log(`\n--- Historical replay summary (${historyDays}d daily closes) ---`);
    console.log(
      JSON.stringify(
        {
          totalPoints: points.length,
          successfulQuotes: okSamples.length,
          failedQuotes: samples.length - okSamples.length,
          premiumUsd: premiumStats
            ? {
                min: Number(premiumStats.min.toFixed(2)),
                max: Number(premiumStats.max.toFixed(2)),
                avg: Number(premiumStats.avg.toFixed(2))
              }
            : null,
          premiumBpsOfNotional: bpsStats
            ? {
                min: Number(bpsStats.min.toFixed(4)),
                max: Number(bpsStats.max.toFixed(4)),
                avg: Number(bpsStats.avg.toFixed(4))
              }
            : null
        },
        null,
        2
      )
    );
  }
}

run().catch((error) => {
  console.error("btc_cover_cost_estimate_failed", error);
  process.exitCode = 1;
});
