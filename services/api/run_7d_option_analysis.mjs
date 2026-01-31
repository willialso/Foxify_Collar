const API_BASE = "https://www.deribit.com/api/v2";

const ASSETS = ["BTC"];
const TIERS = [
  { name: "Pro (Bronze)", drawdownPct: 0.2, fundingUsd: 2500 },
  { name: "Pro (Silver)", drawdownPct: 0.15, fundingUsd: 5000 },
  { name: "Pro (Gold)", drawdownPct: 0.12, fundingUsd: 7500 },
  { name: "Pro (Platinum)", drawdownPct: 0.12, fundingUsd: 10000 }
];
const LEVERAGES = [1, 5, 10];

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

const closestExpiryTag = (instruments, targetDays = 7) => {
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

const findBestPut = async (asset, spot, drawdownPct) => {
  const instruments = await listInstruments(asset);
  if (!instruments.length) {
    return { status: "no_instruments" };
  }
  const expiryTag = closestExpiryTag(instruments, 7);
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

  let best = null;
  for (const inst of candidates) {
    const book = await getOrderBook(inst.instrument_name);
    if (!book) continue;
    const bid = book?.bids?.[0]?.[0] ?? null;
    const ask = book?.asks?.[0]?.[0] ?? null;
    const bidSize = book?.bids?.[0]?.[1] ?? 0;
    const askSize = book?.asks?.[0]?.[1] ?? 0;
    if (!bid || !ask) continue;
    const spread = spreadPct(bid, ask);
    const distance = Math.abs(Number(inst.strike) - targetStrike);
    if (!best || distance < best.distance) {
      best = {
        instrument: inst.instrument_name,
        strike: Number(inst.strike),
        bid,
        ask,
        bidSize,
        askSize,
        spread,
        distance
      };
    }
  }

  if (!best) return { status: "no_book", expiryTag };
  return {
    status: "ok",
    expiryTag,
    targetStrike,
    ...best
  };
};

const run = async () => {
  const results = [];
  for (const asset of ASSETS) {
    let spot = 0;
    try {
      spot = await getIndexPrice(asset);
    } catch {
      spot = 0;
    }
    if (!spot) {
      results.push({ asset, status: "no_spot" });
      continue;
    }

    const perTier = [];
    for (const tier of TIERS) {
      const best = await findBestPut(asset, spot, tier.drawdownPct);
      perTier.push({ tier: tier.name, spot, best });
    }
    results.push({ asset, spot, perTier });
  }

  for (const asset of results) {
    console.log(`\n${asset.asset} spot=${asset.spot || "n/a"}`);
    if (!asset.perTier) {
      console.log(`  status=${asset.status}`);
      continue;
    }
    for (const tierInfo of asset.perTier) {
      const best = tierInfo.best;
      if (best.status !== "ok") {
        console.log(`  ${tierInfo.tier}: status=${best.status}`);
        continue;
      }
      const fee = FEES[asset.asset]?.[tierInfo.tier] ?? 0;
      console.log(
        `  ${tierInfo.tier}: expiry=${best.expiryTag} strike=${best.strike} ask=${best.ask} spread=${(
          best.spread * 100
        ).toFixed(2)}% fee=${fee}`
      );
      for (const lev of LEVERAGES) {
        const notional = TIERS.find((t) => t.name === tierInfo.tier)?.fundingUsd * lev;
        const size = notional / tierInfo.spot;
        const premiumUsd = best.ask * tierInfo.spot * size;
        const ok = premiumUsd <= fee;
        console.log(
          `    ${lev}x: size=${size.toFixed(4)} premium=${premiumUsd.toFixed(2)} vs fee=${fee} ${
            ok ? "OK" : "OVER"
          }`
        );
      }
    }
  }
};

await run();
