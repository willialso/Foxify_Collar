const API_BASE = "https://www.deribit.com/api/v2";

const ASSETS = ["BTC"];
const DAYS = Array.from({ length: 14 }, (_, i) => i + 1);
const LEVERAGES = [1, 5, 10];
const TIERS = [
  { name: "Pro (Bronze)", drawdownPct: 0.2, fundingUsd: 2500 },
  { name: "Pro (Silver)", drawdownPct: 0.15, fundingUsd: 5000 },
  { name: "Pro (Gold)", drawdownPct: 0.12, fundingUsd: 7500 },
  { name: "Pro (Platinum)", drawdownPct: 0.12, fundingUsd: 10000 }
];
const FEES = {
  BTC: { "Pro (Bronze)": 20, "Pro (Silver)": 30, "Pro (Gold)": 50, "Pro (Platinum)": 70 }
};

const fetchJson = async (url) => {
  const res = await fetch(url);
  return res.json();
};

const getIndexPrice = async (asset) => {
  const index = `${asset.toLowerCase()}_usd`;
  const data = await fetchJson(`${API_BASE}/public/get_index_price?index_name=${index}`);
  return Number(data?.result?.index_price || 0);
};

const listInstruments = async (asset) => {
  const data = await fetchJson(
    `${API_BASE}/public/get_instruments?currency=${asset}&kind=option&expired=false`
  );
  return data?.result || [];
};

const getOrderBook = async (instrument) => {
  const data = await fetchJson(
    `${API_BASE}/public/get_order_book?instrument_name=${encodeURIComponent(instrument)}`
  );
  return data?.result || null;
};

const spreadPct = (bid, ask) => {
  if (!bid || !ask) return 1;
  return (ask - bid) / ask;
};

const closestExpiryTag = (instruments, targetDays) => {
  const now = Date.now();
  const targetMs = targetDays * 24 * 60 * 60 * 1000;
  let bestTag = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const inst of instruments) {
    if (!inst.expiration_timestamp || inst.option_type !== "put") continue;
    const diff = Math.abs(inst.expiration_timestamp - now - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestTag = inst.instrument_name.split("-")[1];
    }
  }
  return bestTag;
};

const findBestPut = async (instruments, spot, drawdownPct, targetDays) => {
  if (!instruments.length) {
    return { status: "no_instruments" };
  }
  const expiryTag = closestExpiryTag(instruments, targetDays);
  if (!expiryTag) {
    return { status: "no_expiry" };
  }
  const targetStrike = spot * (1 - drawdownPct);
  const candidates = instruments.filter(
    (inst) => inst.instrument_name?.includes(expiryTag) && inst.option_type === "put"
  );
  if (!candidates.length) {
    return { status: "no_candidates", expiryTag };
  }

  const sorted = candidates
    .map((inst) => ({
      inst,
      distance: Math.abs(Number(inst.strike) - targetStrike)
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);

  let best = null;
  for (const pick of sorted) {
    const book = await getOrderBook(pick.inst.instrument_name);
    if (!book) continue;
    const bid = book?.bids?.[0]?.[0] ?? null;
    const ask = book?.asks?.[0]?.[0] ?? null;
    const bidSize = book?.bids?.[0]?.[1] ?? 0;
    const askSize = book?.asks?.[0]?.[1] ?? 0;
    if (!bid || !ask) continue;
    const spread = spreadPct(bid, ask);
    best = {
      instrument: pick.inst.instrument_name,
      strike: Number(pick.inst.strike),
      bid,
      ask,
      bidSize,
      askSize,
      spread,
      distance: pick.distance
    };
    break;
  }

  if (!best) return { status: "no_book", expiryTag };
  return {
    status: "ok",
    expiryTag,
    targetStrike,
    ...best
  };
};

const computePremiumUsd = (spot, ask, fundingUsd, leverage) => {
  const notional = fundingUsd * leverage;
  const size = notional / spot;
  return ask * spot * size;
};

const run = async () => {
  const ladder = {};

  for (const asset of ASSETS) {
    const spot = await getIndexPrice(asset);
    if (!spot) {
      console.log(`${asset} spot unavailable`);
      continue;
    }
    ladder[asset] = {};
    console.log(`\n${asset} spot=${spot.toFixed(2)}`);

    const instruments = await listInstruments(asset);
    for (const tier of TIERS) {
      const tierFees = FEES[asset][tier.name];
      const perLeverage = {};

      for (const lev of LEVERAGES) {
        let chosen = null;
        for (const days of DAYS) {
          const best = await findBestPut(instruments, spot, tier.drawdownPct, days);
          if (best.status !== "ok") continue;
          const premiumUsd = computePremiumUsd(spot, best.ask, tier.fundingUsd, lev);
          if (premiumUsd <= tierFees) {
            chosen = {
              days,
              premiumUsd,
              ask: best.ask,
              strike: best.strike,
              expiryTag: best.expiryTag,
              spread: best.spread
            };
            break;
          }
        }
        perLeverage[lev] = chosen;
      }

      ladder[asset][tier.name] = perLeverage;
      console.log(`  ${tier.name} fee=${tierFees}`);
      for (const lev of LEVERAGES) {
        const chosen = perLeverage[lev];
        if (!chosen) {
          console.log(`    ${lev}x: no executable option within fee (1-14d)`);
        } else {
          console.log(
            `    ${lev}x: ${chosen.days}d strike=${chosen.strike} ask=${chosen.ask} premium=${chosen.premiumUsd.toFixed(
              2
            )} spread=${(chosen.spread * 100).toFixed(2)}%`
          );
        }
      }
    }
  }
};

await run();
