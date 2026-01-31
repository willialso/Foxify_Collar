import Decimal from "decimal.js";

const API_BASE = "http://127.0.0.1:4100";
const DERIBIT_BASE = "https://www.deribit.com/api/v2";

const TIERS = [
  { name: "Pro (Bronze)", drawdownPct: 0.2, fundingUsd: 2500, fee: 20 },
  { name: "Pro (Silver)", drawdownPct: 0.15, fundingUsd: 5000, fee: 30 },
  { name: "Pro (Gold)", drawdownPct: 0.12, fundingUsd: 7500, fee: 50 },
  { name: "Pro (Platinum)", drawdownPct: 0.12, fundingUsd: 10000, fee: 70 }
];
const LEVERAGES = [1, 5, 10];
const PASS_THROUGH_CAPS = [1.0, 1.5, 2.0, 3.0];

const fetchJson = async (url, options) => {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed: ${res.status} ${text}`);
  }
  return res.json();
};

const getIndexPrice = async (asset) => {
  const index = `${asset.toLowerCase()}_usd`;
  const data = await fetchJson(`${DERIBIT_BASE}/public/get_index_price?index_name=${index}`);
  return Number(data?.result?.index_price || 0);
};

const run = async () => {
  const asset = "BTC";
  const spot = await getIndexPrice(asset);
  if (!spot) {
    console.log("No spot price.");
    return;
  }
  console.log(`Spot: ${spot.toFixed(2)}`);

  for (const tier of TIERS) {
    console.log(`\n${tier.name} (fee=${tier.fee})`);
    for (const lev of LEVERAGES) {
      const notional = tier.fundingUsd * lev;
      const size = notional / spot;
      const basePayload = {
        tierName: tier.name,
        asset,
        spotPrice: spot,
        drawdownFloorPct: tier.drawdownPct,
        fixedPriceUsdc: tier.fee,
        positionSize: size,
        contractSize: 1,
        leverage: lev,
        side: "long",
        coverageId: `test:${tier.name}:${lev}x`,
        targetDays: 7,
        allowPremiumPassThrough: false
      };
      let baseResponse = null;
      let passResponse = null;
      try {
        baseResponse = await fetchJson(`${API_BASE}/put/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(basePayload)
        });
        passResponse = await fetchJson(`${API_BASE}/put/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...basePayload, allowPremiumPassThrough: lev > 1 })
        });
      } catch (error) {
        console.log(`  ${lev}x: error=${error.message}`);
        continue;
      }
      const status = passResponse?.status ?? "unknown";
      const baseFeeUsdc = new Decimal(baseResponse?.feeUsdc ?? 0);
      const passFeeUsdc = new Decimal(passResponse?.feeUsdc ?? 0);
      const premiumUsdc = passResponse?.premiumUsdc ?? null;
      const subsidyUsdc = passResponse?.subsidyUsdc ?? null;
      const reason = passResponse?.reason ?? null;
      const regime = passResponse?.feeRegime ?? null;
      const multiplier = passResponse?.feeRegimeMultiplier ?? null;
      const levMult = passResponse?.feeLeverageMultiplier ?? null;
      const expiryTag = passResponse?.expiryTag ?? null;
      const instrument = passResponse?.instrument ?? null;
      const ratio = baseFeeUsdc.gt(0) ? passFeeUsdc.div(baseFeeUsdc) : new Decimal(0);
      const capFlags = PASS_THROUGH_CAPS.map((cap) =>
        passFeeUsdc.lte(baseFeeUsdc.mul(new Decimal(cap))) ? `${cap}x` : null
      ).filter(Boolean);

      console.log(
        `  ${lev}x: status=${status} baseFee=${baseFeeUsdc.toFixed(2)} ` +
          `passFee=${passFeeUsdc.toFixed(2)} ratio=${ratio.toFixed(2)}x ` +
          `premium=${premiumUsdc} subsidy=${subsidyUsdc} reason=${reason} ` +
          `regime=${regime ?? "n/a"} ivMult=${multiplier ?? "n/a"} levMult=${levMult ?? "n/a"} ` +
          `expiry=${expiryTag ?? "n/a"} instrument=${instrument ?? "n/a"} caps=${capFlags.join(",") || "none"}`
      );
    }
  }
};

await run();
