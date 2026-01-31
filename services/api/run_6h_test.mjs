import { appendFile } from "node:fs/promises";

const API = "http://127.0.0.1:4100";
const LOG_PATH = new URL("../../logs/test-run.log", import.meta.url);

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const MTM_INTERVAL_MS = 2 * 60 * 1000;
const HEDGE_INTERVAL_MS = 10 * 60 * 1000;
const PROFILE_INTERVAL_MS = 45 * 60 * 1000;

const TIER = {
  name: "Pro (Bronze)",
  feeUsd: 10,
  fundingUsd: 2500,
  drawdownFloorUsd: 2000,
  drawdownFloorPct: 0.2
};

const PROFILES = [
  { asset: "BTC", side: "long", marginUsd: 500, leverage: 10 },
  { asset: "BTC", side: "short", marginUsd: 500, leverage: 10 },
  { asset: "BTC", side: "long", marginUsd: 125, leverage: 10 },
  { asset: "BTC", side: "long", marginUsd: 500, leverage: 5 }
];

const activeContexts = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = async (message, data = null) => {
  const entry = {
    ts: new Date().toISOString(),
    message,
    data
  };
  await appendFile(LOG_PATH, `${JSON.stringify(entry)}\n`, "utf-8");
  console.log(message, data || "");
};

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  return res.json();
}

async function getSpot(asset) {
  const index = `${asset.toLowerCase()}_usd`;
  try {
    const data = await fetchJson(
      `https://www.deribit.com/api/v2/public/get_index_price?index_name=${index}`
    );
    return Number(data?.result?.index_price || 0);
  } catch {
    return 0;
  }
}

async function activateProtection(profile) {
  const spot = await getSpot(profile.asset);
  if (!spot) {
    await log("spot_unavailable", profile);
    return;
  }
  const notionalUsdc = profile.marginUsd * profile.leverage;
  const positionSize = notionalUsdc / spot;
  const expiryIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const coverageId = `${TIER.name}:${expiryIso.slice(0, 10)}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  let quote = null;
  if (profile.asset === "BTC") {
    quote = await fetchJson(`${API}/put/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tierName: TIER.name,
        spotPrice: spot,
        drawdownFloorPct: TIER.drawdownFloorPct,
        fixedPriceUsdc: TIER.feeUsd,
        positionSize,
        contractSize: 1,
        leverage: profile.leverage,
        side: profile.side,
        coverageId
      })
    });
  }

  let hedgeType = "option";
  let hedgeInstrument = quote?.instrument || "BTC-PERPETUAL";
  let hedgeSize = Number(quote?.hedgeSize || positionSize);
  let bufferTargetPct = Number(quote?.bufferTargetPct || 0.05);

  if (!quote || quote.status === "no_quote") {
    hedgeType = "perp";
    hedgeInstrument = `${profile.asset}-PERPETUAL`;
    hedgeSize = positionSize;
    bufferTargetPct = 0.04;
  }

  const order = await fetchJson(`${API}/deribit/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instrument: hedgeInstrument,
      amount: hedgeSize,
      side: "buy",
      type: "market",
      coverageId,
      notionalUsdc,
      hedgeType,
      feeUsdc: TIER.feeUsd,
      tierName: TIER.name,
      premiumUsdc: quote?.premiumUsdc ?? null,
      spotPrice: spot,
      leverage: profile.leverage
    })
  });

  if (!["paper_filled", "filled", "ok"].includes(order?.status)) {
    await log("order_rejected", { coverageId, hedgeType, order });
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    tier: TIER.name,
    autoRenew: true,
    feeUsd: TIER.feeUsd,
    totalFeeUsd: TIER.feeUsd,
    selectedIds: [coverageId.slice(-6)],
    coverageId,
    portfolio: {
      tierName: TIER.name,
      positions: [
        {
          id: coverageId.slice(-6),
          asset: profile.asset,
          side: profile.side,
          marginUsd: profile.marginUsd,
          leverage: profile.leverage,
          entryPrice: spot
        }
      ]
    },
    floorUsd: TIER.drawdownFloorUsd,
    equityUsd: TIER.fundingUsd,
    expiryIso,
    notionalUsdc,
    hedge: {
      hedgeType,
      instrument: hedgeInstrument,
      premiumUsdc: quote?.premiumUsdc ?? null,
      hedgeSize,
      optionType: quote?.optionType ?? null,
      strike: quote?.strike ?? null,
      expiryTag: quote?.expiryTag ?? null,
      targetDays: quote?.targetDays ?? null,
      order
    }
  };

  await fetch(`${API}/audit/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  activeContexts.push({
    coverageId,
    hedgeInstrument,
    hedgeSize,
    bufferTargetPct,
    expiryIso,
    renewWindowMinutes: 60,
    renewPayload: {
      tierName: TIER.name,
      spotPrice: spot,
      drawdownFloorPct: TIER.drawdownFloorPct,
      fixedPriceUsdc: TIER.feeUsd,
      expiryTag: quote?.expiryTag,
      amount: hedgeSize,
      renewWindowMinutes: 60,
      expiryIso,
      side: profile.side,
      coverageId
    },
    notionalUsdc,
    hedgeType,
    exposures: [
      {
        asset: profile.asset,
        side: profile.side,
        entryPrice: spot,
        size: positionSize,
        leverage: profile.leverage
      }
    ]
  });

  await log("coverage_activated", { coverageId, hedgeType, instrument: hedgeInstrument });
}

async function runLoopTick(context) {
  await fetch(`${API}/loop/tick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: "demo",
      drawdownLimitUsdc: String(TIER.drawdownFloorUsd),
      initialBalanceUsdc: String(TIER.fundingUsd),
      hedgeInstrument: context.hedgeInstrument,
      hedgeSize: context.hedgeSize,
      bufferTargetPct: context.bufferTargetPct,
      hysteresisPct: 0.02,
      expiryIso: context.expiryIso,
      renewWindowMinutes: context.renewWindowMinutes,
      renewPayload: context.renewPayload,
      coverageId: context.coverageId,
      notionalUsdc: context.notionalUsdc,
      hedgeType: context.hedgeType,
      tierName: TIER.name,
      exposures: context.exposures
    })
  });
}

async function runMtmCredit() {
  await fetch(
    `${API}/risk/summary?cashUsdc=10000&positionPnlUsdc=0&hedgeMtmUsdc=0&drawdownLimitUsdc=9000&initialBalanceUsdc=10000`
  );
}

await log("test_start", { durationHours: 6 });

let profileIndex = 0;
await activateProtection(PROFILES[profileIndex]);

const profileInterval = setInterval(async () => {
  profileIndex = (profileIndex + 1) % PROFILES.length;
  await activateProtection(PROFILES[profileIndex]);
}, PROFILE_INTERVAL_MS);

const hedgeInterval = setInterval(async () => {
  for (const context of activeContexts) {
    await runLoopTick(context);
  }
}, HEDGE_INTERVAL_MS);

const mtmInterval = setInterval(async () => {
  await runMtmCredit();
}, MTM_INTERVAL_MS);

await sleep(SIX_HOURS_MS);

clearInterval(profileInterval);
clearInterval(hedgeInterval);
clearInterval(mtmInterval);

await log("test_complete", { durationHours: 6 });
