import Fastify from "fastify";
import cors from "@fastify/cors";
import { appendFile, readdir, rm, writeFile } from "node:fs/promises";
import Decimal from "decimal.js";
import {
  computeRiskSummary,
  buildFixedPriceOption,
  bestBidAsk,
  spreadPct,
  estimateAverageFill,
  evaluateRollingHedge,
  isFreshPrice,
  hedgeSizeFromNotional,
  hedgeSizeFromDelta,
  capHedgeSize
} from "@foxify/hedging";
import {
  calculateNetExposure,
  MultiVenuePricingEngine,
  VolatilityPredictionEngine,
  RollingNetHedgingEngine,
  PricingRequest,
  SingleVenueRouter,
  BestPriceSplitRouter
} from "@foxify/hedging";
import { DeribitConnector } from "@foxify/connectors";
import { runAutoRenewJob } from "./scheduler";
import { loadAccountConfig } from "./configLoader";
import { createDeribitIvCache } from "./deribitIvCache";
import { createDeribitIvLadderCache } from "./deribitIvLadder";
import { createDeribitExecutor, ExecutionRegistry } from "./executionRegistry";
import {
  loadRiskControls,
  applyRiskAccounting,
  recordRevenue,
  riskSummary,
  liquiditySummary,
  getRiskState,
  canApplySubsidy,
  recordSubsidy,
  subsidySummary,
  resetRiskState
} from "./riskControls";
import { sendWebhookAlert } from "@foxify/hedging";

const app = Fastify();
await app.register(cors, { origin: true });
const LOOP_INTERVAL_MS = Number(process.env.LOOP_INTERVAL_MS || "15000");
const MTM_INTERVAL_MS = Number(process.env.MTM_INTERVAL_MS || "60000");
const APP_MODE = process.env.APP_MODE || "demo";
const FOXIFY_APPROVED = process.env.FOXIFY_APPROVED === "true";
const AUDIT_SEED = process.env.AUDIT_SEED !== "false";
const CONFIG_PATH = process.env.ACCOUNTS_CONFIG_PATH || "../../../configs/live_accounts.json";
const AUDIT_LOG_PATH = new URL("../../../logs/audit.log", import.meta.url);
const LOGS_DIR = new URL("../../../logs/", import.meta.url);
const RISK_CONTROLS_PATH = new URL("../../../configs/risk_controls.json", import.meta.url);
const QUOTE_CACHE_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS || "4000");
const QUOTE_CACHE_STALE_MS = Number(process.env.QUOTE_CACHE_STALE_MS || "20000");
const QUOTE_CACHE_HARD_MS = Number(process.env.QUOTE_CACHE_HARD_MS || "120000");

// Load config at startup (fail fast if invalid)
const configUrl = new URL(CONFIG_PATH, import.meta.url);
await loadAccountConfig(configUrl);
const riskControls = await loadRiskControls(RISK_CONTROLS_PATH);

type QuoteCacheEntry = { ts: number; response: Record<string, unknown> };
const quoteCache = new Map<string, QuoteCacheEntry>();
const quoteInflight = new Map<string, Promise<Record<string, unknown>>>();

function buildQuoteCacheKey(body: {
  tierName?: string;
  asset?: string;
  spotPrice?: number;
  drawdownFloorPct?: number;
  fixedPriceUsdc?: number;
  expiryTag?: string;
  targetDays?: number;
  maxSpreadPct?: number;
  maxSlippagePct?: number;
  minSize?: number;
  positionSize?: number;
  contractSize?: number;
  optionDelta?: number;
  leverage?: number;
  side?: string;
  allowPremiumPassThrough?: boolean;
  ivSnapshot?: number;
}): string {
  return JSON.stringify({
    tierName: body.tierName || "",
    asset: (body.asset || "BTC").toUpperCase(),
    spot: Number(body.spotPrice || 0).toFixed(2),
    drawdown: Number(body.drawdownFloorPct || 0).toFixed(4),
    fixed: Number(body.fixedPriceUsdc || 0).toFixed(2),
    expiryTag: body.expiryTag || "",
    targetDays: Number(body.targetDays || 0),
    positionSize: Number(body.positionSize || 0).toFixed(6),
    contractSize: Number(body.contractSize || 0).toFixed(6),
    optionDelta: body.optionDelta ?? null,
    leverage: Number(body.leverage || 0).toFixed(2),
    side: body.side || "",
    maxSpreadPct: body.maxSpreadPct ?? null,
    maxSlippagePct: body.maxSlippagePct ?? null,
    minSize: body.minSize ?? null,
    allowPremiumPassThrough: !!body.allowPremiumPassThrough,
    ivSnapshot: Number(body.ivSnapshot || 0).toFixed(4)
  });
}

function getQuoteCache(key: string): QuoteCacheEntry | null {
  return quoteCache.get(key) || null;
}

function isQuoteCacheFresh(entry: QuoteCacheEntry): boolean {
  return Date.now() - entry.ts <= QUOTE_CACHE_TTL_MS;
}

function isQuoteCacheStale(entry: QuoteCacheEntry): boolean {
  return Date.now() - entry.ts <= QUOTE_CACHE_STALE_MS;
}

function isQuoteCacheUsable(entry: QuoteCacheEntry): boolean {
  return Date.now() - entry.ts <= QUOTE_CACHE_HARD_MS;
}

function setQuoteCache(key: string, response: Record<string, unknown>): void {
  quoteCache.set(key, { ts: Date.now(), response });
}

async function audit(event: string, payload: Record<string, unknown>): Promise<void> {
  const entry = {
    ts: new Date().toISOString(),
    event,
    payload
  };
  await appendFile(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf-8");
}

async function readAuditEntries(limit = 200): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await (await import("node:fs/promises")).readFile(AUDIT_LOG_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return { ts: new Date().toISOString(), event: "audit_parse_error", payload: { line } };
        }
      });
  } catch {
    return [];
  }
}

async function clearAuditLogs(): Promise<{ cleared: number }> {
  let cleared = 0;
  try {
    const files = await readdir(LOGS_DIR);
    await Promise.all(
      files.map(async (file) => {
        if (file === "audit.log" || (file.startsWith("audit-") && file.endsWith(".json"))) {
          try {
            await rm(new URL(`../../../logs/${file}`, import.meta.url), { force: true });
            cleared += 1;
          } catch {
            // ignore
          }
        }
      })
    );
  } catch {
    // ignore
  }
  return { cleared };
}

async function seedAuditIfEmpty(): Promise<void> {
  if (!AUDIT_SEED) return;
  const entries = await readAuditEntries(1);
  if (entries.length === 0) {
    await audit("audit_seed", { message: "Audit log initialized." });
  }
}

type CoveragePosition = {
  id: string;
  asset: string;
  side: "long" | "short";
  marginUsd: number;
  leverage: number;
  entryPrice: number;
};

type CoverageRecord = {
  coverageId: string;
  expiryIso: string;
  positions: CoveragePosition[];
};

type QuoteBookSnapshot = {
  venue: string;
  instrument: string;
  bidUsd: string | null;
  askUsd: string | null;
  bidSize: string;
  askSize: string;
  spreadPct: string;
  timestampMs: number | null;
  markPriceUsd: string | null;
};

type PortfolioExposure = {
  asset: string;
  side: "long" | "short";
  entryPrice: number;
  size: number;
  leverage: number;
};

const activeCoverages = new Map<string, CoverageRecord>();
const portfolioSnapshots = new Map<string, { positions: PortfolioExposure[]; updatedAt: string }>();
const hedgeLedger = new Map<string, { size: Decimal; avgCostUsdc: Decimal }>();
let realizedHedgePnlUsdc = new Decimal(0);
let lastMtmSnapshot: { equityUsdc: Decimal; positionPnlUsdc: Decimal; hedgeMtmUsdc: Decimal } | null =
  null;

function parseInstrumentAsset(instrument: string): string | null {
  const parts = instrument.split("-");
  if (parts.length >= 1) return parts[0] || null;
  return null;
}

async function computeUnrealizedHedgeMetrics(): Promise<{
  unrealizedHedgePnlUsdc: Decimal;
  hedgeNotionalUsdc: Decimal;
}> {
  let unrealized = new Decimal(0);
  let hedgeNotional = new Decimal(0);
  const entries = Array.from(hedgeLedger.entries());
  for (const [instrument, entry] of entries) {
    if (!entry.size || entry.size.eq(0)) continue;
    let markPriceUsdc: Decimal | null = null;
    try {
      const ticker = await deribit.getTicker(instrument);
      const result = (ticker as any)?.result || {};
      if (instrument.includes("PERPETUAL")) {
        const mark = Number(result?.mark_price ?? result?.last_price ?? 0);
        if (Number.isFinite(mark) && mark > 0) {
          markPriceUsdc = new Decimal(mark);
        }
      } else {
        const markUsd = Number(result?.mark_price_usd ?? 0);
        if (Number.isFinite(markUsd) && markUsd > 0) {
          markPriceUsdc = new Decimal(markUsd);
        } else {
          const markBtc = Number(result?.mark_price ?? 0);
          const underlying = Number(result?.underlying_price ?? 0);
          if (Number.isFinite(markBtc) && markBtc > 0 && Number.isFinite(underlying) && underlying > 0) {
            markPriceUsdc = new Decimal(markBtc).mul(new Decimal(underlying));
          } else {
            const asset = parseInstrumentAsset(instrument);
            if (asset) {
              const index = await deribit.getIndexPrice(`${asset.toLowerCase()}_usd`);
              const spot = Number((index as any)?.result?.index_price ?? 0);
              if (Number.isFinite(markBtc) && markBtc > 0 && Number.isFinite(spot) && spot > 0) {
                markPriceUsdc = new Decimal(markBtc).mul(new Decimal(spot));
              }
            }
          }
        }
      }
    } catch {
      markPriceUsdc = null;
    }
    if (!markPriceUsdc) continue;
    const positionNotional = markPriceUsdc.mul(entry.size.abs());
    hedgeNotional = hedgeNotional.add(positionNotional);
    const pnl = markPriceUsdc.sub(entry.avgCostUsdc).mul(entry.size);
    unrealized = unrealized.add(pnl);
  }
  return { unrealizedHedgePnlUsdc: unrealized, hedgeNotionalUsdc: hedgeNotional };
}

function calculateCoverageStatus(
  position: PortfolioExposure,
  hedge?: {
    optionType?: string | null;
    strike?: number | string | null;
    hedgeSize?: number | string | null;
  },
  drawdownFloorPct = 0.2
): {
  requiredSize: number;
  coveredSize: number;
  coveragePct: number;
  floorStrike: number;
  isCovered: boolean;
} {
  const requiredSize = position.size || 0;
  const coveredSize = Number(hedge?.hedgeSize ?? 0);
  const coveragePct =
    requiredSize > 0 ? Math.min(1, coveredSize / requiredSize) * 100 : 0;
  const floorStrike =
    position.side === "long"
      ? position.entryPrice * (1 - drawdownFloorPct)
      : position.entryPrice * (1 + drawdownFloorPct);
  const isCovered = coveredSize >= requiredSize * 0.99;
  return { requiredSize, coveredSize, coveragePct, floorStrike, isCovered };
}

function serializeDecimal(value: Decimal | null | undefined, digits = 6): string | null {
  if (value === null || value === undefined) return null;
  return value.toFixed(digits);
}

function buildSurvivalCheck(params: {
  spotPrice: Decimal;
  drawdownFloorPct: Decimal;
  optionType: "put" | "call";
  strike?: Decimal | null;
  hedgeSize?: Decimal | null;
  requiredSize?: Decimal | null;
  tolerancePct: Decimal;
}): {
  floorPrice: string;
  requiredCreditUsdc: string;
  hedgeCreditUsdc: string;
  coverageRatio: string;
  pass: boolean;
} | null {
  if (!params.strike || !params.hedgeSize || !params.requiredSize) return null;
  if (params.hedgeSize.lte(0) || params.requiredSize.lte(0)) return null;
  const floorPrice =
    params.optionType === "put"
      ? params.spotPrice.mul(new Decimal(1).minus(params.drawdownFloorPct))
      : params.spotPrice.mul(new Decimal(1).plus(params.drawdownFloorPct));
  const requiredCredit = params.spotPrice.sub(floorPrice).abs().mul(params.requiredSize);
  const intrinsic =
    params.optionType === "put"
      ? Decimal.max(new Decimal(0), params.strike.sub(floorPrice))
      : Decimal.max(new Decimal(0), floorPrice.sub(params.strike));
  const hedgeCredit = intrinsic.mul(params.hedgeSize);
  const coverageRatio = requiredCredit.gt(0) ? hedgeCredit.div(requiredCredit) : new Decimal(1);
  return {
    floorPrice: floorPrice.toFixed(2),
    requiredCreditUsdc: requiredCredit.toFixed(2),
    hedgeCreditUsdc: hedgeCredit.toFixed(2),
    coverageRatio: coverageRatio.toFixed(4),
    pass: coverageRatio.greaterThanOrEqualTo(params.tolerancePct)
  };
}

function buildReplicationMeta(params: {
  targetDays: number;
  maxPreferredDays: number;
  optionType: "put" | "call";
}): Record<string, unknown> | null {
  if (params.targetDays <= params.maxPreferredDays) return null;
  return {
    enabled: true,
    reason: "extended_tenor",
    targetDays: params.targetDays,
    preferredMaxDays: params.maxPreferredDays,
    deltaOverlay: true,
    optionType: params.optionType
  };
}

function applyMinFee(tierName: string, feeUsdc: Decimal): Decimal {
  const minFee = riskControls.min_fee_usdc_by_tier?.[tierName];
  if (!minFee || !Number.isFinite(minFee)) return feeUsdc;
  return Decimal.max(feeUsdc, new Decimal(minFee));
}

function applyDurationFee(feeUsdc: Decimal, targetDays: number): Decimal {
  const baseDays = riskControls.default_target_days ?? 7;
  const perDayPct = riskControls.duration_fee_per_day_pct ?? 0;
  const maxPct = riskControls.duration_fee_max_pct ?? 0;
  if (!perDayPct || targetDays <= baseDays) return feeUsdc;
  const extraDays = Math.max(0, targetDays - baseDays);
  const upliftPct = Math.min(maxPct, extraDays * perDayPct);
  return feeUsdc.mul(new Decimal(1).add(new Decimal(upliftPct)));
}

function applyFeeRegime(
  tierName: string,
  feeUsdc: Decimal,
  iv?: number
): { fee: Decimal; regime: "low" | "normal" | "high" | null; multiplier: Decimal | null } {
  if (!iv) return { fee: feeUsdc, regime: null, multiplier: null };
  const thresholds = riskControls.fee_iv_regime_thresholds;
  if (!thresholds || !Number.isFinite(thresholds.low) || !Number.isFinite(thresholds.high)) {
    return { fee: feeUsdc, regime: null, multiplier: null };
  }
  const regime = iv < thresholds.low ? "low" : iv < thresholds.high ? "normal" : "high";
  const multiplier =
    riskControls.fee_iv_regime_multipliers_by_tier?.[tierName]?.[regime] ?? 1;
  if (!Number.isFinite(multiplier) || multiplier === 1) {
    return { fee: feeUsdc, regime, multiplier: new Decimal(1) };
  }
  return { fee: feeUsdc.mul(new Decimal(multiplier)), regime, multiplier: new Decimal(multiplier) };
}

function findLeverageMultiplier(
  leverage: number | undefined,
  multipliers?: Record<string, number>
): number | null {
  if (!multipliers) return null;
  const lev = Number(leverage ?? 1);
  const entries = Object.entries(multipliers)
    .map(([key, value]) => ({ leverage: Number(key), multiplier: value }))
    .filter((entry) => Number.isFinite(entry.leverage) && Number.isFinite(entry.multiplier))
    .sort((a, b) => a.leverage - b.leverage);
  if (!entries.length) return null;
  let selected = entries[0].multiplier;
  for (const entry of entries) {
    if (entry.leverage <= lev) selected = entry.multiplier;
  }
  return Number.isFinite(selected) ? selected : null;
}

function applyLeverageFee(
  feeUsdc: Decimal,
  leverage?: number
): { fee: Decimal; multiplier: Decimal | null } {
  const selected = findLeverageMultiplier(leverage, riskControls.fee_leverage_multipliers_by_x);
  if (!Number.isFinite(selected) || !selected || selected <= 0) {
    return { fee: feeUsdc, multiplier: new Decimal(1) };
  }
  if (selected === 1) {
    return { fee: feeUsdc, multiplier: new Decimal(1) };
  }
  return { fee: feeUsdc.mul(new Decimal(selected)), multiplier: new Decimal(selected) };
}

function resolveMaxLeverage(): number {
  const max = riskControls.max_leverage ?? 10;
  return Number.isFinite(max) && max > 0 ? max : 10;
}

function normalizeLeverage(rawLeverage?: number): { ok: boolean; value: number; max: number } {
  const max = resolveMaxLeverage();
  const value = Number(rawLeverage ?? 1);
  if (!Number.isFinite(value) || value < 1 || value > max) {
    return { ok: false, value: 1, max };
  }
  return { ok: true, value, max };
}

function resolvePassThroughCapMultiplier(leverage?: number): Decimal | null {
  const selected = findLeverageMultiplier(leverage, riskControls.pass_through_cap_by_leverage);
  if (!Number.isFinite(selected) || !selected || selected <= 0) return null;
  return new Decimal(selected);
}

function applyPassThroughCap(
  baseFee: Decimal,
  allInPremium: Decimal,
  leverage?: number
): { maxFee: Decimal | null; capped: boolean; capMultiplier: Decimal | null } {
  const capMultiplier = resolvePassThroughCapMultiplier(leverage);
  if (!capMultiplier) return { maxFee: null, capped: false, capMultiplier: null };
  const maxFee = baseFee.mul(capMultiplier);
  const capped = allInPremium.gt(maxFee);
  return { maxFee, capped, capMultiplier };
}

function applyBronzeFixedFee(
  tierName: string,
  leverage: number,
  feeUsdc: Decimal
): { fee: Decimal; applied: boolean } {
  if (tierName !== "Pro (Bronze)" || leverage > 2) {
    return { fee: feeUsdc, applied: false };
  }
  return { fee: new Decimal(20), applied: true };
}

function applyIvFeeUplift(tierName: string, feeUsdc: Decimal, iv?: number): Decimal {
  if (!iv) return feeUsdc;
  const threshold = riskControls.fee_iv_uplift_threshold ?? riskControls.volatility_throttle_iv ?? 0.8;
  if (iv <= threshold) return feeUsdc;
  const uplift = riskControls.fee_iv_uplift_pct_by_tier?.[tierName] ?? 0;
  if (!uplift) return feeUsdc;
  return feeUsdc.mul(new Decimal(1).add(new Decimal(uplift)));
}

type NormalizedIv = { raw: number; scaled: number };

function normalizeIvValue(iv: number): NormalizedIv {
  const raw = Number.isFinite(iv) && iv > 0 ? iv : 0;
  if (!raw) return { raw: 0, scaled: 0 };
  const scaled = raw > 1.5 ? raw / 100 : raw;
  return { raw, scaled: Number.isFinite(scaled) && scaled > 0 ? scaled : 0 };
}

async function resolveFeeIv(asset: string, iv?: number): Promise<NormalizedIv> {
  if (Number.isFinite(iv) && (iv as number) > 0) {
    return normalizeIvValue(iv as number);
  }
  if (asset.toUpperCase() === "BTC") {
    const ladder = ivLadder.getSnapshot();
    if (ladder) {
      return normalizeIvValue(ladder.hedgeIv);
    }
  }
  const fallback = await ivCache.getAtmIv(asset);
  return normalizeIvValue(Number(fallback.toFixed(6)));
}

async function calculateFeeBase(params: {
  tierName: string;
  baseFeeUsdc: Decimal;
  targetDays: number;
  leverage: number;
  asset: string;
  ivCandidate?: number;
}): Promise<{
  feeUsdc: Decimal;
  feeRegime: { regime: "low" | "normal" | "high" | null; multiplier: Decimal | null };
  feeLeverage: { multiplier: Decimal | null };
  feeIv: NormalizedIv;
}> {
  const feeIv = await resolveFeeIv(params.asset, params.ivCandidate);
  let feeUsdc = applyMinFee(params.tierName, params.baseFeeUsdc);
  feeUsdc = applyDurationFee(feeUsdc, params.targetDays);
  const ctcEnabled = riskControls.ctc_enabled ?? false;
  const feeRegime = ctcEnabled
    ? { fee: feeUsdc, regime: null, multiplier: null }
    : applyFeeRegime(params.tierName, feeUsdc, feeIv.scaled);
  feeUsdc = feeRegime.fee;
  if (!ctcEnabled && !feeRegime.regime) {
    feeUsdc = applyIvFeeUplift(params.tierName, feeUsdc, feeIv.scaled);
  }
  const feeLeverage = ctcEnabled
    ? { fee: feeUsdc, multiplier: new Decimal(1) }
    : applyLeverageFee(feeUsdc, params.leverage);
  feeUsdc = feeLeverage.fee;
  const bronzeFixed = applyBronzeFixedFee(params.tierName, params.leverage, feeUsdc);
  feeUsdc = bronzeFixed.fee;
  return { feeUsdc, feeRegime, feeLeverage, feeIv };
}

function selectClosestBucket(value: number, buckets: number[]): number | null {
  if (!buckets.length) return null;
  let best = buckets[0];
  let bestDiff = Math.abs(value - best);
  for (const bucket of buckets) {
    const diff = Math.abs(value - bucket);
    if (diff < bestDiff) {
      best = bucket;
      bestDiff = diff;
    }
  }
  return best;
}

function calculateCtcSafetyFee(params: {
  tierName: string;
  drawdownPct: Decimal;
  spotPrice: Decimal;
  positionSize: Decimal;
  leverage: number;
}): { feeUsdc: Decimal | null; baseIv: number | null; hedgeIv: number | null } {
  if (!(riskControls.ctc_enabled ?? false)) return { feeUsdc: null, baseIv: null, hedgeIv: null };
  if (params.tierName === "Pro (Bronze)" && params.leverage <= 2) {
    return { feeUsdc: null, baseIv: null, hedgeIv: null };
  }
  const ladder = ivLadder.getSnapshot();
  if (!ladder || !ladder.legs.length) {
    return { feeUsdc: null, baseIv: null, hedgeIv: null };
  }
  const bucket =
    selectClosestBucket(
      params.drawdownPct.toNumber(),
      riskControls.ctc_floor_buckets ?? [0.12, 0.16, 0.2]
    ) ?? params.drawdownPct.toNumber();
  const weights = new Map([
    [1, 0.2],
    [3, 0.3],
    [7, 0.5]
  ]);
  const floorPrice = params.spotPrice.mul(new Decimal(1).minus(params.drawdownPct));
  if (floorPrice.lte(0)) return { feeUsdc: null, baseIv: ladder.baseIv, hedgeIv: ladder.hedgeIv };
  const notionalUsdc = params.spotPrice.mul(params.positionSize).mul(new Decimal(params.leverage));
  const bufferPct = riskControls.ctc_buffer_pct ?? 0.15;
  const targetUsd = notionalUsdc
    .mul(params.drawdownPct)
    .mul(new Decimal(1).add(new Decimal(bufferPct)));
  let totalCost = new Decimal(0);
  const pickLeg = (tenorDays: number) => {
    const candidates = ladder.legs.filter(
      (leg) =>
        Number.isFinite(leg.markPrice) &&
        !!leg.markPrice &&
        Number.isFinite(leg.strike)
    );
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const leg of candidates) {
      const tenorDiff = Math.abs(leg.tenorDays - tenorDays);
      const floorDiff = Math.abs(leg.floorPct - bucket);
      const score = tenorDiff * 10 + floorDiff;
      if (score < bestScore) {
        best = leg;
        bestScore = score;
      }
    }
    return best;
  };

  for (const [tenorDays, weight] of weights.entries()) {
    const leg = pickLeg(tenorDays);
    if (!leg || !Number.isFinite(leg.markPrice) || !leg.markPrice || !Number.isFinite(leg.strike)) {
      return { feeUsdc: null, baseIv: ladder.baseIv, hedgeIv: ladder.hedgeIv };
    }
    const strike = new Decimal(leg.strike);
    const intrinsic = strike.minus(floorPrice);
    if (intrinsic.lte(0)) {
      return { feeUsdc: null, baseIv: ladder.baseIv, hedgeIv: ladder.hedgeIv };
    }
    const legTarget = targetUsd.mul(new Decimal(weight));
    const size = legTarget.div(intrinsic);
    const markPriceBtc = new Decimal(leg.markPrice);
    const legCost = markPriceBtc.mul(params.spotPrice).mul(size);
    totalCost = totalCost.add(legCost);
  }
  const marginPct = riskControls.ctc_margin_by_tier?.[params.tierName] ?? 0.4;
  const opsBuffer = riskControls.ctc_ops_buffer_usdc_by_tier?.[params.tierName] ?? 0;
  const feeUsdc = totalCost.mul(new Decimal(1).add(new Decimal(marginPct))).add(new Decimal(opsBuffer));
  return { feeUsdc, baseIv: ladder.baseIv, hedgeIv: ladder.hedgeIv };
}

function applyPartialDiscount(feeUsdc: Decimal, coverageRatio: Decimal): Decimal {
  const discountPct = riskControls.partial_coverage_discount_pct ?? 0;
  if (!discountPct) return feeUsdc;
  const coverage = Decimal.min(new Decimal(1), Decimal.max(new Decimal(0), coverageRatio));
  const discounted = feeUsdc.mul(coverage).mul(new Decimal(1).minus(new Decimal(discountPct)));
  return Decimal.max(new Decimal(0), discounted);
}

function updateHedgeLedger(params: {
  instrument: string;
  sizeDelta: Decimal;
  fillPriceUsdc: Decimal;
}): void {
  const entry = hedgeLedger.get(params.instrument) ?? {
    size: new Decimal(0),
    avgCostUsdc: new Decimal(0)
  };
  const currentSize = entry.size;
  const delta = params.sizeDelta;

  const sameDirection = currentSize.eq(0) || currentSize.mul(delta).gt(0);
  if (sameDirection) {
    const newSize = currentSize.add(delta);
    const totalCost = entry.avgCostUsdc.mul(currentSize.abs()).add(params.fillPriceUsdc.mul(delta.abs()));
    entry.size = newSize;
    entry.avgCostUsdc = newSize.eq(0) ? new Decimal(0) : totalCost.div(newSize.abs());
    hedgeLedger.set(params.instrument, entry);
    return;
  }

  const closeSize = Decimal.min(currentSize.abs(), delta.abs());
  const isLong = currentSize.gt(0);
  const pnl = isLong
    ? params.fillPriceUsdc.sub(entry.avgCostUsdc).mul(closeSize)
    : entry.avgCostUsdc.sub(params.fillPriceUsdc).mul(closeSize);
  realizedHedgePnlUsdc = realizedHedgePnlUsdc.add(pnl);

  const newSize = currentSize.add(delta);
  entry.size = newSize;
  if (newSize.eq(0)) {
    entry.avgCostUsdc = new Decimal(0);
  }
  hedgeLedger.set(params.instrument, entry);
}

function premiumFloorBreached(premiumTotal: Decimal, feeUsdc: Decimal): {
  breached: boolean;
  ratio: Decimal;
  threshold: Decimal;
} {
  const threshold = new Decimal(riskControls.premium_floor_ratio ?? 1.25);
  if (feeUsdc.lte(0)) {
    return { breached: true, ratio: new Decimal(999), threshold };
  }
  const ratio = premiumTotal.div(feeUsdc);
  return { breached: ratio.gt(threshold), ratio, threshold };
}

function canCoverageOverride(tierName: string): boolean {
  const allowed = riskControls.coverage_override_tiers ?? [];
  return allowed.includes(tierName);
}

function getCombinedExposureBook(): {
  exposures: Array<{
    asset: string;
    side: "long" | "short";
    entryPrice: number;
    size: number;
    leverage: number;
  }>;
  coverageIds: string[];
} {
  const now = Date.now();
  for (const [key, record] of activeCoverages.entries()) {
    const expiryMs = Date.parse(record.expiryIso);
    if (Number.isFinite(expiryMs) && expiryMs <= now) {
      activeCoverages.delete(key);
    }
  }
  const exposures: Array<{
    asset: string;
    side: "long" | "short";
    entryPrice: number;
    size: number;
    leverage: number;
  }> = [];
  const coverageIds: string[] = [];
  for (const record of activeCoverages.values()) {
    coverageIds.push(record.coverageId);
    for (const pos of record.positions) {
      if (pos.asset !== "BTC") continue;
      const notional = pos.marginUsd * pos.leverage;
      const size = pos.entryPrice ? notional / pos.entryPrice : 0;
      exposures.push({
        asset: pos.asset,
        side: pos.side,
        entryPrice: pos.entryPrice,
        size,
        leverage: pos.leverage
      });
    }
  }
  return { exposures, coverageIds };
}

app.get("/health", async () => ({ status: "ok" }));

app.post("/portfolio/ingest", async (req) => {
  const body = req.body as {
    accountId: string;
    positions: PortfolioExposure[];
    source?: string;
  };
  if (!body?.accountId || !Array.isArray(body.positions)) {
    return { status: "error", reason: "invalid_payload" };
  }
  if (body.positions.some((pos) => pos.asset !== "BTC")) {
    return { status: "error", reason: "unsupported_asset" };
  }
  const updatedAt = new Date().toISOString();
  portfolioSnapshots.set(body.accountId, { positions: body.positions, updatedAt });
  await audit("portfolio_ingest", {
    accountId: body.accountId,
    positions: body.positions.length,
    source: body.source || null,
    updatedAt
  });
  return { status: "ok", accountId: body.accountId, count: body.positions.length, updatedAt };
});

app.get("/coverage/report", async (req) => {
  const query = req.query as { accountId?: string };
  const accountId = query.accountId || "demo";
  const portfolio = portfolioSnapshots.get(accountId);
  const coverages = await readAuditEntries(500);
  const coverageEvents = coverages.filter((entry) => entry.event === "coverage_activated");

  const latestByPosition = new Map<string, Record<string, unknown>>();
  for (const entry of coverageEvents) {
    const payload = entry.payload as any;
    const pos = payload?.portfolio?.positions?.[0];
    if (!pos?.asset || !pos?.side || !pos?.entryPrice) continue;
    const key = `${pos.asset}|${pos.side}|${pos.leverage}|${pos.entryPrice}`;
    latestByPosition.set(key, payload);
  }
  const matchCoverage = (position: PortfolioExposure): Record<string, unknown> | null => {
    const key = `${position.asset}|${position.side}|${position.leverage}|${position.entryPrice}`;
    if (latestByPosition.has(key)) return latestByPosition.get(key) as Record<string, unknown>;
    const candidates: Array<{ payload: Record<string, unknown>; diff: number }> = [];
    for (const payload of latestByPosition.values()) {
      const pos = (payload as any)?.portfolio?.positions?.[0];
      if (!pos?.asset || !pos?.side || !pos?.entryPrice || !pos?.leverage) continue;
      if (pos.asset !== position.asset || pos.side !== position.side) continue;
      const notional = Number(pos.marginUsd || 0) * Number(pos.leverage || 1);
      const size = pos.entryPrice ? notional / Number(pos.entryPrice) : 0;
      const diff = Math.abs(size - position.size);
      candidates.push({ payload, diff });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.diff - b.diff);
    return candidates[0].payload;
  };

  const positions = portfolio?.positions ?? [];
  const results = positions.map((pos, idx) => {
    const id = `pos_${idx + 1}`;
    const coverage = matchCoverage(pos) as any;
    const hedge = coverage?.hedge || null;
    const drawdownFloorPct =
      coverage?.equityUsd && coverage?.floorUsd
        ? Math.max(0, 1 - Number(coverage.floorUsd) / Number(coverage.equityUsd))
        : 0.2;
    const status = calculateCoverageStatus(
      {
        asset: pos.asset,
        side: pos.side,
        entryPrice: pos.entryPrice,
        size: pos.size,
        leverage: pos.leverage
      },
      {
        optionType: hedge?.optionType ?? null,
        strike: hedge?.strike ?? null,
        hedgeSize: hedge?.hedgeSize ?? null
      },
      drawdownFloorPct
    );
    return {
      positionId: id,
      asset: pos.asset,
      side: pos.side,
      entryPrice: pos.entryPrice,
      size: pos.size,
      leverage: pos.leverage,
      coverageId: coverage?.coverageId ?? null,
      hedgeInstrument: hedge?.instrument ?? null,
      expiryTag: hedge?.expiryTag ?? null,
      optionType: hedge?.optionType ?? null,
      strike: hedge?.strike ?? null,
      reason: coverage?.reason ?? null,
      feeUsd: coverage?.feeUsd ?? null,
      premiumUsd: hedge?.premiumUsdc ?? null,
      subsidyUsd: hedge?.subsidyUsdc ?? null,
      requiredSize: status.requiredSize,
      coveredSize: status.coveredSize,
      coveragePct: status.coveragePct.toFixed(2),
      floorStrike: status.floorStrike,
      isCovered: status.isCovered
    };
  });

  const covered = results.filter((r) => r.isCovered).length;
  return {
    status: "ok",
    accountId,
    positions: results.length,
    covered,
    coveragePct: results.length ? ((covered / results.length) * 100).toFixed(2) : "0",
    results
  };
});

app.get("/integration/handshake", async () => {
  return {
    status: "ok",
    mode: APP_MODE,
    approved: FOXIFY_APPROVED,
    timestamp: new Date().toISOString()
  };
});

app.addHook("onRequest", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    reply.status(204).send();
  }
});

app.get("/risk/summary", async (req) => {
  const query = req.query as {
    cashUsdc?: string;
    positionPnlUsdc?: string;
    hedgeMtmUsdc?: string;
    drawdownLimitUsdc?: string;
    initialBalanceUsdc?: string;
    maxMtmAgeMs?: string;
    assets?: string;
  };
  let positionPnl = new Decimal(query.positionPnlUsdc || "0");
  let hedgeMtm = new Decimal(query.hedgeMtmUsdc || "0");
  const maxMtmAgeMs = Number(query.maxMtmAgeMs || "15000");

  const needsPositionPnl = !query.positionPnlUsdc;
  const needsHedgeMtm = !query.hedgeMtmUsdc;
  if (needsPositionPnl || needsHedgeMtm) {
    try {
      const assets = ["BTC"];
      for (const asset of assets) {
        const positions = await deribit.getPositions(asset);
        if (needsPositionPnl) {
          positionPnl = positions.reduce((acc, pos) => {
            const pnl = pos.floating_profit_loss ?? pos.unrealized_pnl ?? 0;
            return acc.plus(new Decimal(pnl));
          }, positionPnl);
        }

        if (needsHedgeMtm) {
          hedgeMtm = positions
            .filter((pos) => pos.kind === "option")
            .reduce((acc, pos) => {
              const mark = pos.mark_price ?? 0;
              const freshness = isFreshPrice((pos as any).last_update_timestamp, maxMtmAgeMs);
              if (!freshness.isFresh) {
                return acc;
              }
              return acc.plus(new Decimal(mark).mul(new Decimal(pos.size || 0)));
            }, hedgeMtm);
        }
      }
    } catch (err) {
      app.log.error(err);
    }
  }

  const summary = computeRiskSummary(
    {
      cashUsdc: new Decimal(query.cashUsdc || "10000"),
      positionPnlUsdc: positionPnl,
      hedgeMtmUsdc: hedgeMtm,
      drawdownLimitUsdc: new Decimal(query.drawdownLimitUsdc || "9000")
    },
    new Decimal(query.initialBalanceUsdc || "10000")
  );

  const response = {
    equityUsdc: summary.equityUsdc.toFixed(2),
    drawdownLimitUsdc: summary.drawdownLimitUsdc.toFixed(2),
    drawdownBufferUsdc: summary.drawdownBufferUsdc.toFixed(2),
    drawdownBufferPct: summary.drawdownBufferPct.mul(100).toFixed(2)
  };
  lastMtmSnapshot = {
    equityUsdc: summary.equityUsdc,
    positionPnlUsdc: positionPnl,
    hedgeMtmUsdc: hedgeMtm
  };
  const mtmHasValue = !positionPnl.isZero() || !hedgeMtm.isZero();
  if (mtmHasValue) {
    await audit("mtm_credit", {
      equityUsdc: response.equityUsdc,
      positionPnlUsdc: positionPnl.toFixed(4),
      hedgeMtmUsdc: hedgeMtm.toFixed(4)
    });
  }
  return response;
});

const deribitEnv = (process.env.DERIBIT_ENV as "testnet" | "live") || "testnet";
const deribitPaper =
  process.env.DERIBIT_PAPER !== undefined
    ? process.env.DERIBIT_PAPER === "true"
    : deribitEnv !== "live";

const deribit = new DeribitConnector(
  deribitEnv,
  deribitPaper,
  process.env.DERIBIT_CLIENT_ID && process.env.DERIBIT_CLIENT_SECRET
    ? {
        clientId: process.env.DERIBIT_CLIENT_ID,
        clientSecret: process.env.DERIBIT_CLIENT_SECRET
      }
    : undefined
);
const executionRegistry = new ExecutionRegistry();
executionRegistry.register(createDeribitExecutor(deribit));
const pricingEngine = new MultiVenuePricingEngine([
  {
    name: "deribit",
    async getQuote(request: PricingRequest) {
      const book = await deribit.getOrderBook(request.instrument);
      const orderBook = (book as any)?.result;
      if (!orderBook) return null;
      const { bid, ask } = bestBidAsk(orderBook);
      if (!bid || !ask) return null;
      return {
        venue: "deribit",
        instrument: request.instrument,
        type: request.type,
        book: {
          bid: bid ? new Decimal(bid) : null,
          ask: ask ? new Decimal(ask) : null,
          bidSize: new Decimal(orderBook.bids?.[0]?.[1] || 0),
          askSize: new Decimal(orderBook.asks?.[0]?.[1] || 0),
          spreadPct: spreadPct(bid, ask),
          timestampMs: orderBook.timestamp ?? null
        }
      };
    }
  }
]);
const ivCache = createDeribitIvCache(deribit, { ttlMs: 15000, fallbackIv: 0.5 });
const ivLadder = createDeribitIvLadderCache(deribit, {
  asset: "BTC",
  expiriesDays: [1, 2, 3, 5, 7],
  floorPcts: [0.12, 0.16, 0.2],
  refreshMs: 300000,
  maxAgeMs: 5000,
  maxSnapshotAgeMs: riskControls.ctc_max_snapshot_age_ms ?? 10000,
  priceBufferPct: riskControls.ctc_price_buffer_pct ?? 0.02
});
ivLadder.start();
const ladderWarmup = setInterval(() => {
  const snapshot = ivLadder.getSnapshot();
  if (snapshot) {
    console.log(`[iv] ladder_ready base=${snapshot.baseIv.toFixed(4)} hedge=${snapshot.hedgeIv.toFixed(4)}`);
    clearInterval(ladderWarmup);
  }
}, 1000);
setTimeout(() => clearInterval(ladderWarmup), 15000);
const predictionEngine = new VolatilityPredictionEngine(async (asset) => {
  if (!asset || asset.length === 0) return new Decimal(0.5);
  if (asset !== "BTC" && asset !== "ETH") return new Decimal(0.5);
  return ivCache.getAtmIv(asset);
});
const executionRouter = new BestPriceSplitRouter(3);

function buildBestPriceCandidates(
  quotes: Array<{
    venue: string;
    instrument: string;
    type: "option" | "perp" | "spot";
    book: {
      bid: Decimal | null;
      ask: Decimal | null;
      bidSize: Decimal;
      askSize: Decimal;
      spreadPct: Decimal;
      timestampMs: number | null;
    };
  }>,
  side: "buy" | "sell"
): Array<{
  venue: string;
  instrument: string;
  type: "option" | "perp" | "spot";
  side: "buy" | "sell";
  price: Decimal;
  size: Decimal;
  spreadPct: Decimal;
  timestampMs: number | null;
}> {
  return quotes
    .map((quote) => {
      const price = side === "buy" ? quote.book.ask : quote.book.bid;
      const size = side === "buy" ? quote.book.askSize : quote.book.bidSize;
      if (!price || size.lte(0)) return null;
      return {
        venue: quote.venue,
        instrument: quote.instrument,
        type: quote.type,
        side,
        price,
        size,
        spreadPct: quote.book.spreadPct,
        timestampMs: quote.book.timestampMs
      };
    })
    .filter(Boolean) as Array<{
    venue: string;
    instrument: string;
    type: "option" | "perp" | "spot";
    side: "buy" | "sell";
    price: Decimal;
    size: Decimal;
    spreadPct: Decimal;
    timestampMs: number | null;
  }>;
}
const netHedgingEngine = new RollingNetHedgingEngine();

function buildDayRing(targetDays: number, minDays = 1, maxDays = 14): number[] {
  const ring: number[] = [];
  const clamped = Math.min(maxDays, Math.max(minDays, Math.round(targetDays)));
  ring.push(clamped);
  for (let step = 1; step <= maxDays; step += 1) {
    const down = clamped - step;
    const up = clamped + step;
    if (down >= minDays) ring.push(down);
    if (up <= maxDays) ring.push(up);
    if (ring.length >= maxDays - minDays + 1) break;
  }
  return ring;
}

function buildDayLadder(targetDays: number, maxPreferredDays: number, maxFallbackDays: number): number[] {
  const preferred = buildDayRing(targetDays, 1, maxPreferredDays);
  if (maxFallbackDays <= maxPreferredDays) return preferred;
  const fallback: number[] = [];
  for (let day = maxPreferredDays + 1; day <= maxFallbackDays; day += 1) {
    fallback.push(day);
  }
  return preferred.concat(fallback);
}

function selectProbeInstruments(
  instruments: Array<any>,
  expiryTag: string,
  optionType: "put" | "call",
  spotPrice: Decimal,
  maxCount: number
): Array<any> {
  const scoped = instruments.filter(
    (inst) => inst.option_type === optionType && inst.instrument_name?.includes(expiryTag)
  );
  return scoped
    .sort((a, b) => {
      const distA = new Decimal(a.strike || 0).minus(spotPrice).abs();
      const distB = new Decimal(b.strike || 0).minus(spotPrice).abs();
      return distA.sub(distB).toNumber();
    })
    .slice(0, maxCount);
}

function selectStrikeCandidates(
  instruments: Array<any>,
  expiryTag: string,
  optionType: "put" | "call",
  spotPrice: Decimal,
  drawdownFloorPct: Decimal,
  maxCount: number
): Array<any> {
  const floorStrike =
    optionType === "put"
      ? spotPrice.mul(new Decimal(1).minus(drawdownFloorPct))
      : spotPrice.mul(new Decimal(1).plus(drawdownFloorPct));
  const scoped = instruments.filter(
    (inst) => inst.option_type === optionType && inst.instrument_name?.includes(expiryTag)
  );
  return scoped
    .sort((a, b) => {
      const distA = new Decimal(a.strike || 0).minus(floorStrike).abs();
      const distB = new Decimal(b.strike || 0).minus(floorStrike).abs();
      return distA.sub(distB).toNumber();
    })
    .slice(0, maxCount);
}

async function getOptionVenueQuotes(
  instrument: string,
  spotPrice: Decimal
): Promise<
  Array<{
    venue: string;
    instrument: string;
    type: "option";
    book: {
      bid: Decimal | null;
      ask: Decimal | null;
      bidSize: Decimal;
      askSize: Decimal;
      spreadPct: Decimal;
      timestampMs: number | null;
      markPriceUsd?: Decimal | null;
    };
  }>
> {
  const quotes: Array<{
    venue: string;
    instrument: string;
    type: "option";
    book: {
      bid: Decimal | null;
      ask: Decimal | null;
      bidSize: Decimal;
      askSize: Decimal;
      spreadPct: Decimal;
      timestampMs: number | null;
      markPriceUsd?: Decimal | null;
    };
  }> = [];
  const deribitBook = await deribit.getOrderBook(instrument);
  const deribitOrderBook = (deribitBook as any)?.result;
  if (deribitOrderBook) {
    const { bid, ask } = bestBidAsk(deribitOrderBook);
    const markPrice = deribitOrderBook.mark_price ?? null;
    const bidUsd = bid ? new Decimal(bid).mul(spotPrice) : null;
    const askUsd = ask ? new Decimal(ask).mul(spotPrice) : null;
    const markUsd = markPrice ? new Decimal(markPrice).mul(spotPrice) : null;
    quotes.push({
      venue: "deribit",
      instrument,
      type: "option",
      book: {
        bid: bidUsd,
        ask: askUsd,
        bidSize: new Decimal(deribitOrderBook.bids?.[0]?.[1] || 0),
        askSize: new Decimal(deribitOrderBook.asks?.[0]?.[1] || 0),
        spreadPct: spreadPct(bid || 0, ask || 0),
        timestampMs: deribitOrderBook.timestamp ?? null,
        markPriceUsd: markUsd
      }
    });
  }

  return quotes;
}

function aggregateOptionQuotes(
  quotes: Array<{
    venue: string;
    instrument: string;
    type: "option";
    book: {
      bid: Decimal | null;
      ask: Decimal | null;
      bidSize: Decimal;
      askSize: Decimal;
      spreadPct: Decimal;
      timestampMs: number | null;
      markPriceUsd?: Decimal | null;
    };
  }>,
  side: "buy" | "sell",
  requiredSize: Decimal
): {
  avgPrice: Decimal | null;
  filledSize: Decimal;
  bestBid: Decimal | null;
  bestAsk: Decimal | null;
  spread: Decimal;
  totalBidSize: Decimal;
  totalAskSize: Decimal;
  plans: Array<{ venue: string; instrument: string; side: "buy" | "sell"; size: Decimal; price: Decimal }>;
} {
  const candidates = buildBestPriceCandidates(quotes, side);
  const plans = executionRouter.route(candidates, requiredSize).map((plan) => ({
    venue: plan.venue,
    instrument: plan.instrument,
    side: plan.side,
    size: plan.size,
    price: plan.price
  }));
  let filledSize = new Decimal(0);
  let cost = new Decimal(0);
  for (const plan of plans) {
    filledSize = filledSize.add(plan.size);
    cost = cost.add(plan.price.mul(plan.size));
  }
  const avgPrice = filledSize.gt(0) ? cost.div(filledSize) : null;

  const bestBid = quotes.reduce<Decimal | null>((acc, quote) => {
    if (!quote.book.bid) return acc;
    if (!acc) return quote.book.bid;
    return quote.book.bid.gt(acc) ? quote.book.bid : acc;
  }, null);
  const bestAsk = quotes.reduce<Decimal | null>((acc, quote) => {
    if (!quote.book.ask) return acc;
    if (!acc) return quote.book.ask;
    return quote.book.ask.lt(acc) ? quote.book.ask : acc;
  }, null);
  const totalBidSize = quotes.reduce((acc, quote) => acc.add(quote.book.bidSize), new Decimal(0));
  const totalAskSize = quotes.reduce((acc, quote) => acc.add(quote.book.askSize), new Decimal(0));
  const spread =
    bestBid && bestAsk
      ? spreadPct(bestBid.toNumber(), bestAsk.toNumber())
      : new Decimal(1);

  return {
    avgPrice,
    filledSize,
    bestBid,
    bestAsk,
    spread,
    totalBidSize,
    totalAskSize,
    plans
  };
}

async function buildExpirySearchOrder(
  instruments: Array<any>,
  optionType: "put" | "call",
  spotPrice: Decimal,
  drawdownFloorPct: Decimal,
  requiredSize: Decimal,
  maxSpreadPct: Decimal,
  targetDays: number,
  maxPreferredDays: number,
  maxFallbackDays: number
): Promise<Array<{ expiryTag: string; targetDays: number }>> {
  const ring = buildDayLadder(targetDays, maxPreferredDays, maxFallbackDays);
  const dayToTag = new Map<number, string>();
  for (const day of ring) {
    const tag = await closestExpiryTagForTarget(instruments, day);
    if (tag) dayToTag.set(day, tag);
  }
  const uniqueTags = Array.from(new Set(dayToTag.values()));
  const tagToDays = new Map<string, number>();
  for (const tag of uniqueTags) {
    const days = targetDaysForExpiryTag(instruments, tag);
    tagToDays.set(tag, days ?? targetDays);
  }

  const probeCount = 4;
  const liquidityScores = await Promise.all(
    uniqueTags.map(async (tag) => {
      const probes = selectProbeInstruments(instruments, tag, optionType, spotPrice, probeCount);
      if (probes.length === 0) return { tag, score: new Decimal(0) };
      let total = new Decimal(0);
      let count = 0;
      for (const inst of probes) {
        const quotes = await getOptionVenueQuotes(inst.instrument_name, spotPrice);
        if (!quotes.length) continue;
        const agg = aggregateOptionQuotes(quotes, "buy", requiredSize);
        if (!agg.bestAsk || !agg.bestBid) continue;
        if (agg.spread.gt(maxSpreadPct)) continue;
        const spreadScore = new Decimal(1).minus(
          Decimal.min(agg.spread.div(maxSpreadPct), new Decimal(1))
        );
        const sizeScore = requiredSize.lte(0)
          ? new Decimal(1)
          : Decimal.min(agg.totalAskSize.div(requiredSize), new Decimal(1));
        const liquidityScore = spreadScore.mul(new Decimal(0.6)).add(sizeScore.mul(new Decimal(0.4)));
        total = total.add(liquidityScore);
        count += 1;
      }
      return { tag, score: count ? total.div(count) : new Decimal(0) };
    })
  );

  const anchor = liquidityScores.reduce<{ tag: string | null; score: Decimal }>(
    (acc, entry) => {
      if (!acc.tag || entry.score.gt(acc.score)) {
        return { tag: entry.tag, score: entry.score };
      }
      return acc;
    },
    { tag: null, score: new Decimal(0) }
  );

  const ordered: Array<{ expiryTag: string; targetDays: number }> = [];
  if (anchor.tag) {
    ordered.push({ expiryTag: anchor.tag, targetDays: tagToDays.get(anchor.tag) ?? targetDays });
  }
  for (const day of ring) {
    const tag = dayToTag.get(day);
    if (!tag) continue;
    if (ordered.some((entry) => entry.expiryTag === tag)) continue;
    ordered.push({ expiryTag: tag, targetDays: tagToDays.get(tag) ?? day });
  }
  return ordered;
}

function resolveLiquidityThresholds(
  days: number,
  override: boolean,
  baseSpreadPct: number,
  baseSlippagePct: number,
  useBodySpread: boolean,
  useBodySlippage: boolean
): { maxSpreadPct: Decimal; maxSlippagePct: Decimal } {
  const spreadByDays = override
    ? riskControls.liquidity_override_spread_pct_by_days
    : riskControls.max_spread_pct_by_days;
  const slippageByDays = override
    ? riskControls.liquidity_override_slippage_pct_by_days
    : riskControls.max_slippage_pct_by_days;
  const fallbackSpreadPct = override
    ? riskControls.liquidity_override_spread_pct ?? baseSpreadPct ?? 0.05
    : baseSpreadPct ?? 0.05;
  const fallbackSlippagePct = override
    ? riskControls.liquidity_override_slippage_pct ?? baseSlippagePct ?? 0.01
    : baseSlippagePct ?? 0.01;
  const dayKey = String(days);
  const spreadPct =
    useBodySpread ? baseSpreadPct : spreadByDays?.[dayKey] ?? fallbackSpreadPct;
  const slippagePct =
    useBodySlippage ? baseSlippagePct : slippageByDays?.[dayKey] ?? fallbackSlippagePct;
  return {
    maxSpreadPct: new Decimal(spreadPct),
    maxSlippagePct: new Decimal(slippagePct)
  };
}

app.get("/deribit/instruments", async () => {
  return deribit.listInstruments("BTC");
});

app.get("/deribit/ticker", async (req) => {
  const instrument = (req.query as { instrument?: string }).instrument || "BTC-29MAR24-50000-P";
  return deribit.getTicker(instrument);
});

app.post("/deribit/order", async (req) => {
  const body = req.body as {
    instrument: string;
    amount: number;
    side: "buy" | "sell";
    type?: "limit" | "market";
    price?: number;
    venue?: string;
    coverageId?: string;
    notionalUsdc?: number;
    hedgeType?: string;
    feeUsdc?: number;
    tierName?: string;
    premiumUsdc?: number;
    spotPrice?: number;
    leverage?: number;
    feeRecognized?: boolean;
    subsidyUsdc?: number;
    reason?: string;
    accountId?: string;
    intent?: "open" | "close" | "hedge";
    drawdownLimitUsdc?: string;
    initialBalanceUsdc?: string;
    assets?: string[];
    asset?: string;
    positionPnlUsdc?: string;
    hedgeMtmUsdc?: string;
    floorPrice?: number;
  };
  if (body.intent === "close") {
    if (!body.drawdownLimitUsdc || !body.initialBalanceUsdc) {
      await audit("close_blocked", {
        reason: "missing_drawdown_inputs",
        accountId: body.accountId || null,
        instrument: body.instrument
      });
      return { status: "blocked", reason: "missing_drawdown_inputs" };
    }
    const assets = body.assets?.length
      ? body.assets
      : body.asset
        ? [body.asset]
        : [];
    const assetsQuery = assets.length ? `&assets=${encodeURIComponent(assets.join(","))}` : "";
    const params = new URLSearchParams({
      drawdownLimitUsdc: body.drawdownLimitUsdc,
      initialBalanceUsdc: body.initialBalanceUsdc,
      cashUsdc: body.initialBalanceUsdc,
      positionPnlUsdc: body.positionPnlUsdc ?? "0",
      hedgeMtmUsdc: body.hedgeMtmUsdc ?? "0",
      maxMtmAgeMs: "15000"
    });
    const guard = await app.inject({
      method: "GET",
      url: `/risk/summary?${params.toString()}${assetsQuery}`
    });
    const payload = guard.json() as { drawdownBufferUsdc?: string; drawdownBufferPct?: string };
    const bufferUsdc = Number(payload.drawdownBufferUsdc ?? "0");
    if (bufferUsdc > 0) {
      await audit("close_blocked", {
        reason: "drawdown_buffer_positive",
        accountId: body.accountId || null,
        instrument: body.instrument,
        bufferUsdc: payload.drawdownBufferUsdc ?? "0",
        bufferPct: payload.drawdownBufferPct ?? "0"
      });
      return {
        status: "blocked",
        reason: "drawdown_buffer_positive",
        bufferUsdc: payload.drawdownBufferUsdc ?? "0",
        bufferPct: payload.drawdownBufferPct ?? "0"
      };
    }
  }
  const venue = body.venue || "deribit";
  const inferredHedgeType =
    body.hedgeType || (body.instrument.includes("PERPETUAL") ? "perp" : "option");
  const response = await executionRegistry.placeOrder(venue, {
    instrument: body.instrument,
    amount: body.amount,
    side: body.side,
    type: body.type,
    price: body.price
  });
  const status = String((response as any)?.status || "");
  const filledAmount = Number((response as any)?.filledAmount ?? body.amount);
  const fillPrice =
    (response as any)?.result?.average_price ??
    (response as any)?.result?.price ??
    (response as any)?.fillPrice ??
    null;
  const spotPrice = body.spotPrice ?? null;
  const executedPremiumUsdc =
    inferredHedgeType === "option" && fillPrice && spotPrice
      ? Number(new Decimal(fillPrice).mul(new Decimal(spotPrice)).mul(filledAmount))
      : null;
  const fillPriceUsdc =
    inferredHedgeType === "option"
      ? fillPrice && spotPrice
        ? new Decimal(fillPrice).mul(new Decimal(spotPrice))
        : null
      : fillPrice
        ? new Decimal(fillPrice)
        : null;
  const hedgeNotionalUsdc =
    inferredHedgeType === "perp" && fillPrice
      ? Number(new Decimal(fillPrice).mul(new Decimal(filledAmount)))
      : null;
  const hedgeMarginUsdc =
    inferredHedgeType === "perp" && hedgeNotionalUsdc && body.leverage
      ? hedgeNotionalUsdc / Number(body.leverage)
      : 0;
  const executed = status === "paper_filled" || status === "filled" || status === "ok";
  if (executed && fillPriceUsdc) {
    const sizeDelta = new Decimal(filledAmount).mul(body.side === "buy" ? 1 : -1);
    updateHedgeLedger({
      instrument: body.instrument,
      sizeDelta,
      fillPriceUsdc
    });
  }
  await audit("hedge_order", {
    instrument: body.instrument,
    side: body.side,
    amount: filledAmount,
    type: body.type ?? "market",
    coverageId: body.coverageId || null,
    notionalUsdc: body.notionalUsdc ?? null,
    hedgeType: inferredHedgeType,
    status: status || "submitted",
    fillPrice,
    premiumUsdc: executedPremiumUsdc ?? body.premiumUsdc ?? null,
    feeUsdc: body.feeUsdc ?? null,
    subsidyUsdc: body.subsidyUsdc ?? null,
    reason: body.reason ?? null,
    accountId: body.accountId ?? null,
    floorPrice: body.floorPrice ?? null,
    hedgeNotionalUsdc,
    hedgeMarginUsdc,
    bestBid: (response as any)?.bestBid ?? null,
    bestAsk: (response as any)?.bestAsk ?? null,
    availableSize: (response as any)?.availableSize ?? null
  });
  if (executed && body.tierName && body.feeUsdc !== undefined) {
    const premiumForAccounting =
      inferredHedgeType === "option"
        ? Number(executedPremiumUsdc ?? body.premiumUsdc ?? 0)
        : 0;
    const feeForAccounting = body.feeRecognized ? 0 : Number(body.feeUsdc);
    const accounting = applyRiskAccounting(
      body.tierName,
      feeForAccounting,
      premiumForAccounting,
      Number(body.notionalUsdc ?? 0),
      hedgeMarginUsdc
    );
    await audit("liquidity_update", {
      coverageId: body.coverageId || null,
      tier: body.tierName,
      feeUsdc: feeForAccounting,
      premiumUsdc: premiumForAccounting,
      subsidyUsdc: body.subsidyUsdc ?? 0,
      notionalUsdc: body.notionalUsdc ?? 0,
      hedgeNotionalUsdc,
      hedgeMarginUsdc,
      delta: accounting.liquidityDelta,
      totals: liquiditySummary()
    });
    if (body.subsidyUsdc && body.subsidyUsdc > 0) {
      recordSubsidy(body.tierName, body.accountId || null, Number(body.subsidyUsdc));
    }
  }
  return response;
});

app.get("/deribit/positions", async () => {
  return deribit.getPositions("BTC");
});

app.get("/pricing/btc", async () => {
  return deribit.getIndexPrice("btc_usd");
});

app.get("/pricing/iv/:asset", async (req) => {
  const asset = String((req.params as { asset?: string })?.asset || "")
    .toUpperCase()
    .trim();
  if (asset !== "BTC") {
    return { asset, iv: null };
  }
  const ladder = ivLadder.getSnapshot();
  if (ladder) {
    return { asset, iv: Number(ladder.baseIv.toFixed(6)), ivHedge: Number(ladder.hedgeIv.toFixed(6)) };
  }
  const iv = await ivCache.getAtmIv(asset);
  return { asset, iv: Number(iv.toFixed(6)) };
});

app.post("/pricing/ctc", async (req) => {
  const body = req.body as {
    tierName?: string;
    asset?: string;
    spotPrice: number;
    drawdownFloorPct: number;
    positionSize: number;
    leverage?: number;
  };
  const asset = (body.asset || "BTC").toUpperCase();
  if (asset !== "BTC") {
    return { status: "no_quote", reason: "unsupported_asset" };
  }
  const leverageCheck = normalizeLeverage(body.leverage);
  if (!leverageCheck.ok) {
    return { status: "no_quote", reason: "invalid_leverage", maxLeverage: leverageCheck.max };
  }
  const tierName = body.tierName || "Unknown";
  const spotPrice = new Decimal(body.spotPrice || 0);
  const drawdownFloorPct = new Decimal(body.drawdownFloorPct || 0);
  const positionSize = new Decimal(body.positionSize || 0);
  if (spotPrice.lte(0) || positionSize.lte(0)) {
    return { status: "no_quote", reason: "invalid_position" };
  }
  if (tierName === "Pro (Bronze)" && leverageCheck.value <= 2) {
    return { status: "ok", feeUsdc: "20.00", reason: "bronze_fixed" };
  }
  const ctcSafety = calculateCtcSafetyFee({
    tierName,
    drawdownPct: drawdownFloorPct,
    spotPrice,
    positionSize,
    leverage: leverageCheck.value
  });
  if (ctcSafety.feeUsdc) {
    return {
      status: "ok",
      feeUsdc: ctcSafety.feeUsdc.toFixed(2),
      reason: "ctc_safety",
      ivBase: ctcSafety.baseIv,
      ivHedge: ctcSafety.hedgeIv
    };
  }
  return { status: "no_quote", reason: "ctc_unavailable" };
});

app.get("/risk/mtm", async () => {
  const positions = await deribit.getPositions("BTC");
  const positionPnl = positions.reduce((acc, pos) => {
    const pnl = pos.floating_profit_loss ?? pos.unrealized_pnl ?? 0;
    return acc.plus(new Decimal(pnl));
  }, new Decimal(0));

  const optionMtm = positions
    .filter((pos) => pos.kind === "option")
    .reduce((acc, pos) => {
      const mark = pos.mark_price ?? 0;
      return acc.plus(new Decimal(mark).mul(new Decimal(pos.size || 0)));
    }, new Decimal(0));

  return {
    positionPnlUsdc: positionPnl.toFixed(4),
    hedgeMtmUsdc: optionMtm.toFixed(4),
    positions
  };
});

type PutQuoteRequest = {
  tierName?: string;
  fundingUsdc?: number;
  asset?: string;
  spotPrice: number;
  drawdownFloorPct: number;
  fixedPriceUsdc: number;
  expiryTag?: string;
  targetDays?: number;
  maxSpreadPct?: number;
  maxSlippagePct?: number;
  minSize?: number;
  positionSize?: number;
  contractSize?: number;
  optionDelta?: number;
  leverage?: number;
  ivSnapshot?: number;
  side?: "long" | "short";
  coverageId?: string;
  accountId?: string;
  allowPremiumPassThrough?: boolean;
};

function startQuoteCompute(body: PutQuoteRequest, cacheKey: string): Promise<Record<string, unknown>> {
  const existing = quoteInflight.get(cacheKey);
  if (existing) return existing;
  const promise = (async () => {
    const res = await app.inject({
      method: "POST",
      url: "/put/quote",
      payload: body
    });
    return res.json() as Record<string, unknown>;
  })();
  quoteInflight.set(cacheKey, promise);
  promise.finally(() => quoteInflight.delete(cacheKey));
  return promise;
}

app.post("/put/preview", async (req) => {
  const body = req.body as PutQuoteRequest;
  const cacheKey = buildQuoteCacheKey(body);
  const cached = getQuoteCache(cacheKey);
  if (cached && isQuoteCacheFresh(cached)) {
    return { ...cached.response, cached: true, stale: false };
  }
  if (cached && isQuoteCacheStale(cached)) {
    startQuoteCompute(body, cacheKey);
    return { ...cached.response, cached: true, stale: true };
  }
  if (cached && isQuoteCacheUsable(cached)) {
    startQuoteCompute(body, cacheKey);
    return { ...cached.response, cached: true, stale: true };
  }
  startQuoteCompute(body, cacheKey);
  return { status: "pending", cached: false, stale: false };
});

app.post("/put/quote", async (req) => {
  const body = req.body as PutQuoteRequest;
  const cacheKey = buildQuoteCacheKey(body);
  const cached = getQuoteCache(cacheKey);
  if (cached && isQuoteCacheFresh(cached)) {
    return cached.response;
  }

  const asset = (body.asset || "BTC").toUpperCase();
  if (asset !== "BTC") {
    return {
      status: "no_quote",
      reason: "unsupported_asset"
    };
  }
  const instruments = await deribit.listInstruments(asset);
  const results = (instruments as any)?.result || [];
  if (!results.length) {
    return {
      status: "no_quote",
      reason: "unsupported_asset"
    };
  }
  if (!results.length) {
    return {
      status: "no_quote",
      expiryTag: "",
      targetDays: 0,
      reason: "unsupported_asset"
    };
  }
  const useBodySpread = body.maxSpreadPct !== undefined;
  const useBodySlippage = body.maxSlippagePct !== undefined;
  const baseMaxSpreadPct = useBodySpread
    ? body.maxSpreadPct
    : (riskControls.max_spread_pct ?? 0.05);
  const baseMaxSlippagePct = useBodySlippage
    ? body.maxSlippagePct
    : (riskControls.max_slippage_pct ?? 0.01);
  const minSize = new Decimal(body.minSize ?? riskControls.min_option_size ?? 0.01);
  const positionSize = new Decimal(body.positionSize ?? 1);
  const contractSize = new Decimal(body.contractSize ?? 1);
  const leverageCheck = normalizeLeverage(body.leverage);
  if (!leverageCheck.ok) {
    return {
      status: "no_quote",
      reason: "invalid_leverage",
      maxLeverage: leverageCheck.max
    };
  }
  const leverage = leverageCheck.value;
  const hedgeSize = body.optionDelta
    ? hedgeSizeFromDelta(new Decimal(positionSize), new Decimal(body.optionDelta))
    : hedgeSizeFromNotional(positionSize, contractSize);
  const requiredSize = Decimal.max(minSize, hedgeSize);

  const optionType = body.side === "short" ? "call" : "put";
  const spotPrice = new Decimal(body.spotPrice);
  const drawdownFloorPct = new Decimal(body.drawdownFloorPct);
  const tierName = body.tierName || "Unknown";
  const expiryTargetDays = body.expiryTag
    ? targetDaysForExpiryTag(results, body.expiryTag)
    : null;
  const defaultTargetDays = riskControls.default_target_days ?? 7;
  const maxPreferredDays = riskControls.max_target_days ?? 7;
  const maxFallbackDays = riskControls.fallback_target_days ?? 14;
  const targetDays = Math.min(
    maxFallbackDays,
    Math.max(1, Math.round(body.targetDays ?? expiryTargetDays ?? defaultTargetDays))
  );
  const expirySearchOrder = body.expiryTag
    ? [{ expiryTag: body.expiryTag, targetDays: expiryTargetDays ?? targetDays }]
    : await buildExpirySearchOrder(
        results,
        optionType,
        spotPrice,
        drawdownFloorPct,
        requiredSize,
        new Decimal(baseMaxSpreadPct ?? 0.05),
        targetDays,
        maxPreferredDays,
        maxFallbackDays
      );
  let chosenExecutionPlans:
    | Array<{ venue: string; instrument: string; side: "buy" | "sell"; size: Decimal; price: Decimal }>
    | null = null;
  let chosenSnapshots: Map<string, QuoteBookSnapshot[]> | null = null;
  let bestCandidate: {
    expiryTag: string;
    targetDays: number;
    premiumPerUnit: Decimal;
    premiumTotal: Decimal;
    availableSize: Decimal;
    strike: Decimal;
    iv?: number;
    spreadPct: Decimal;
    rollMultiplier: number;
    allInPremium: Decimal;
  } | null = null;
  let bestSnapshots: QuoteBookSnapshot[] | null = null;
  const rejected = {
    missingBook: 0,
    spreadTooWide: 0,
    sizeTooSmall: 0,
    noBidAsk: 0,
    slippageTooHigh: 0
  };

  const liquidityOverrideEnabled = riskControls.liquidity_override_enabled ?? false;
  let liquidityOverrideUsed = false;

  for (const overridePass of [false, true]) {
    if (overridePass && !liquidityOverrideEnabled) break;
    bestCandidate = null;
    bestSnapshots = null;
    chosenExecutionPlans = null;
    chosenSnapshots = null;

    for (const entry of expirySearchOrder) {
      const expiryTag = entry.expiryTag;
      const days = entry.targetDays;
      if (!expiryTag) continue;

      const plansByStrike = new Map<
        string,
        Array<{ venue: string; instrument: string; side: "buy" | "sell"; size: Decimal; price: Decimal }>
      >();
      const snapshotsByStrike = new Map<string, QuoteBookSnapshot[]>();
      const strikeCandidates = selectStrikeCandidates(
        results,
        expiryTag,
        optionType,
        spotPrice,
        drawdownFloorPct,
        40
      );
      const { maxSpreadPct, maxSlippagePct } = resolveLiquidityThresholds(
        days,
        overridePass,
        baseMaxSpreadPct ?? 0.05,
        baseMaxSlippagePct ?? 0.01,
        useBodySpread,
        useBodySlippage
      );

      for (const inst of strikeCandidates) {
        const quotes = await getOptionVenueQuotes(inst.instrument_name, spotPrice);
        if (!quotes.length) {
          rejected.missingBook += 1;
          continue;
        }
        const snapshots = quotes.map((quote) => ({
          venue: quote.venue,
          instrument: quote.instrument,
          bidUsd: serializeDecimal(quote.book.bid, 6),
          askUsd: serializeDecimal(quote.book.ask, 6),
          bidSize: serializeDecimal(quote.book.bidSize, 6) ?? "0",
          askSize: serializeDecimal(quote.book.askSize, 6) ?? "0",
          spreadPct: serializeDecimal(quote.book.spreadPct, 6) ?? "0",
          timestampMs: quote.book.timestampMs ?? null,
          markPriceUsd: serializeDecimal(quote.book.markPriceUsd, 6)
        }));
        snapshotsByStrike.set(new Decimal(inst.strike).toFixed(0), snapshots);
        const agg = aggregateOptionQuotes(quotes, "buy", requiredSize);
        if (!agg.bestBid || !agg.bestAsk) {
          rejected.noBidAsk += 1;
          continue;
        }
        if (agg.spread.gt(maxSpreadPct)) {
          rejected.spreadTooWide += 1;
          continue;
        }
        if (!agg.avgPrice || agg.filledSize.lte(0)) {
          rejected.sizeTooSmall += 1;
          continue;
        }
        const slippagePct = agg.avgPrice.minus(agg.bestAsk).div(agg.bestAsk);
        if (slippagePct.gt(maxSlippagePct)) {
          rejected.slippageTooHigh += 1;
          continue;
        }

        const ticker = await deribit.getTicker(inst.instrument_name);
        const iv = Number((ticker as any)?.result?.mark_iv ?? 0);
        const premiumPerUnit = agg.avgPrice;
        const premiumTotal = premiumPerUnit.mul(requiredSize);
        const rollMultiplier = Math.max(1, Math.ceil(targetDays / days));
        const allInPremium = premiumTotal.mul(new Decimal(rollMultiplier));
        if (!bestCandidate || allInPremium.lt(bestCandidate.allInPremium)) {
          bestCandidate = {
            expiryTag,
            targetDays: days,
            premiumPerUnit,
            premiumTotal,
            availableSize: agg.totalAskSize,
            strike: new Decimal(inst.strike),
            iv,
            spreadPct: agg.spread,
            rollMultiplier,
            allInPremium
          };
          bestSnapshots = snapshots;
          chosenExecutionPlans = agg.plans;
          chosenSnapshots = snapshotsByStrike;
        }
        plansByStrike.set(new Decimal(inst.strike).toFixed(0), agg.plans);
      }
    }

    if (bestCandidate) {
      liquidityOverrideUsed = overridePass;
      break;
    }
  }

  const quote = bestCandidate;
  const survivalTolerance = new Decimal(
    riskControls.survival_tolerance_pct ?? 0.98
  );
  const replicationMeta = quote
    ? buildReplicationMeta({
        targetDays: quote.targetDays,
        maxPreferredDays,
        optionType
      })
    : null;

  if (!quote) {
    if (!bestCandidate || !bestCandidate.premiumPerUnit.gt(0)) {
      await audit("put_quote_failed", {
        reason: "no_quote",
        expiryTag: body.expiryTag || "",
        targetDays: 0,
        optionType,
        rejected,
        liquidityOverride: liquidityOverrideUsed
      });
      return {
        status: "no_quote",
        expiryTag: body.expiryTag || "",
        targetDays: 0,
        rejected,
        liquidityOverride: liquidityOverrideUsed
      };
    }

    const candidateIv =
      Number.isFinite(bestCandidate.iv) && (bestCandidate.iv ?? 0) > 0
        ? bestCandidate.iv
        : body.ivSnapshot;
    const feeBase = await calculateFeeBase({
      tierName,
      baseFeeUsdc: new Decimal(body.fixedPriceUsdc),
      targetDays: bestCandidate.targetDays,
      leverage,
      asset,
      ivCandidate: candidateIv
    });
    let feeUsdc = feeBase.feeUsdc;
    const feeRegime = feeBase.feeRegime;
    const feeLeverage = feeBase.feeLeverage;
    const feeIv = feeBase.feeIv;
    const ctcSafety = calculateCtcSafetyFee({
      tierName,
      drawdownPct: drawdownFloorPct,
      spotPrice,
      positionSize,
      leverage
    });
    let feeReason = "flat_fee";
    if (ctcSafety.feeUsdc && ctcSafety.feeUsdc.gt(feeUsdc)) {
      feeUsdc = ctcSafety.feeUsdc;
      feeReason = "ctc_safety";
    }
    const premiumTotal = bestCandidate.premiumTotal;
    const allInPremium = bestCandidate.allInPremium;
    const premiumFloor = premiumFloorBreached(allInPremium, feeUsdc);
    let subsidyNeeded = allInPremium.minus(feeUsdc);
    let subsidyCheck = canApplySubsidy(
      tierName,
      body.accountId || null,
      subsidyNeeded.toNumber(),
      feeIv.scaled
    );
    const canPassThrough = FOXIFY_APPROVED && body.allowPremiumPassThrough;
    const passThroughCapInfo = applyPassThroughCap(feeUsdc, allInPremium, leverage);
    const fallbackReplication = buildReplicationMeta({
      targetDays: bestCandidate.targetDays,
      maxPreferredDays,
      optionType
    });
    const survivalCheck = buildSurvivalCheck({
      spotPrice,
      drawdownFloorPct,
      optionType,
      strike: bestCandidate.strike,
      hedgeSize: requiredSize,
      requiredSize,
      tolerancePct: survivalTolerance
    });
    const fallbackSnapshot = bestSnapshots
      ? {
          expiryTag: bestCandidate.expiryTag,
          targetDays: bestCandidate.targetDays,
          strike: bestCandidate.strike.toFixed(0),
          books: bestSnapshots
        }
      : null;
    const canFullyCover = bestCandidate.availableSize.greaterThanOrEqualTo(requiredSize);

    if (premiumFloor.breached) {
      if (canPassThrough && !passThroughCapInfo.capped) {
        const optionSymbol = optionType === "put" ? "P" : "C";
        const optionInstrument = buildInstrumentName(
          asset,
          bestCandidate.expiryTag,
          bestCandidate.strike.toFixed(0),
          optionSymbol
        );
        return {
          status: "pass_through",
          expiryTag: bestCandidate.expiryTag,
          targetDays: bestCandidate.targetDays,
          optionType,
          strike: bestCandidate.strike.toFixed(0),
          instrument: optionInstrument,
          premiumUsdc: premiumTotal.toFixed(2),
          premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
          hedgeSize: requiredSize.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          subsidyUsdc: "0.00",
          feeUsdc: allInPremium.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier
            ? feeLeverage.multiplier.toFixed(4)
            : null,
          passThroughCapMultiplier: passThroughCapInfo.capMultiplier
            ? passThroughCapInfo.capMultiplier.toFixed(4)
            : null,
          passThroughCapped: false,
          reason: "premium_floor_pass_through",
          liquidityOverride: liquidityOverrideUsed,
          replication: fallbackReplication,
          survivalCheck,
          selectionSnapshot: fallbackSnapshot,
          rollMultiplier: bestCandidate.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
          warning: {
            type: "premium_floor",
            ratio: premiumFloor.ratio.toFixed(4),
            threshold: premiumFloor.threshold.toFixed(4)
          }
        };
      }
      if (!canPassThrough || !passThroughCapInfo.maxFee) {
        return {
          status: "premium_floor",
          expiryTag: bestCandidate.expiryTag,
          targetDays: bestCandidate.targetDays,
          optionType,
          strike: bestCandidate.strike.toFixed(0),
          premiumUsdc: premiumTotal.toFixed(2),
          premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
          hedgeSize: requiredSize.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          subsidyUsdc: "0.00",
          feeUsdc: feeUsdc.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: passThroughCapInfo.capMultiplier
            ? passThroughCapInfo.capMultiplier.toFixed(4)
            : null,
          passThroughCapped: passThroughCapInfo.capped,
          reason: passThroughCapInfo.capped ? "premium_floor_pass_through_capped" : "premium_floor",
          liquidityOverride: liquidityOverrideUsed,
          replication: fallbackReplication,
          survivalCheck,
          selectionSnapshot: fallbackSnapshot,
          rollMultiplier: bestCandidate.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
          warning: {
            type: "premium_floor",
            ratio: premiumFloor.ratio.toFixed(4),
            threshold: premiumFloor.threshold.toFixed(4)
          }
        };
      }
      feeUsdc = passThroughCapInfo.maxFee;
      const bronzeFixedCapped = applyBronzeFixedFee(tierName, leverage, feeUsdc);
      feeUsdc = bronzeFixedCapped.fee;
      subsidyNeeded = allInPremium.minus(feeUsdc);
      subsidyCheck = canApplySubsidy(
        tierName,
        body.accountId || null,
        subsidyNeeded.toNumber(),
      feeIv.scaled
      );
    }

    if (subsidyNeeded.gt(0) && subsidyCheck.allowed && canFullyCover) {
      const optionSymbol = optionType === "put" ? "P" : "C";
      const optionInstrument = buildInstrumentName(
        asset,
        bestCandidate.expiryTag,
        bestCandidate.strike.toFixed(0),
        optionSymbol
      );
      return {
        status: "subsidized",
        expiryTag: bestCandidate.expiryTag,
        targetDays: bestCandidate.targetDays,
        optionType,
        strike: bestCandidate.strike.toFixed(0),
        instrument: optionInstrument,
        premiumUsdc: premiumTotal.toFixed(2),
        premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
        hedgeSize: requiredSize.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: "0.00",
        markIv: feeIv.raw,
        subsidyUsdc: subsidyNeeded.toFixed(2),
        feeUsdc: feeUsdc.toFixed(2),
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: passThroughCapInfo.capMultiplier
          ? passThroughCapInfo.capMultiplier.toFixed(4)
          : null,
        passThroughCapped: passThroughCapInfo.capped,
        reason: "subsidized",
        capBreached: false,
        liquidityOverride: liquidityOverrideUsed,
        replication: fallbackReplication,
        survivalCheck,
        selectionSnapshot: fallbackSnapshot,
        rollMultiplier: bestCandidate.rollMultiplier,
        rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
      };
    }

    if (subsidyNeeded.gt(0) && canFullyCover && canCoverageOverride(tierName)) {
      const optionSymbol = optionType === "put" ? "P" : "C";
      const optionInstrument = buildInstrumentName(
        asset,
        bestCandidate.expiryTag,
        bestCandidate.strike.toFixed(0),
        optionSymbol
      );
      return {
        status: "subsidized",
        expiryTag: bestCandidate.expiryTag,
        targetDays: bestCandidate.targetDays,
        optionType,
        strike: bestCandidate.strike.toFixed(0),
        instrument: optionInstrument,
        premiumUsdc: premiumTotal.toFixed(2),
        premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
        hedgeSize: requiredSize.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: "0.00",
        markIv: feeIv.raw,
        subsidyUsdc: subsidyNeeded.toFixed(2),
        feeUsdc: feeUsdc.toFixed(2),
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: passThroughCapInfo.capMultiplier
          ? passThroughCapInfo.capMultiplier.toFixed(4)
          : null,
        passThroughCapped: passThroughCapInfo.capped,
        reason: "coverage_override",
        capBreached: true,
        subsidyCapReason: subsidyCheck.reason,
        liquidityOverride: liquidityOverrideUsed,
        replication: fallbackReplication,
        survivalCheck,
        selectionSnapshot: fallbackSnapshot,
        rollMultiplier: bestCandidate.rollMultiplier,
        rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
      };
    }

    if (canPassThrough && allInPremium.gt(feeUsdc)) {
      const passThroughCapInfoLate = applyPassThroughCap(feeUsdc, allInPremium, leverage);
      if (!passThroughCapInfoLate.capped) {
        const optionSymbol = optionType === "put" ? "P" : "C";
        const optionInstrument = buildInstrumentName(
          asset,
          bestCandidate.expiryTag,
          bestCandidate.strike.toFixed(0),
          optionSymbol
        );
        return {
          status: "pass_through",
          expiryTag: bestCandidate.expiryTag,
          targetDays: bestCandidate.targetDays,
          optionType,
          strike: bestCandidate.strike.toFixed(0),
          instrument: optionInstrument,
          premiumUsdc: premiumTotal.toFixed(2),
          premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
          hedgeSize: requiredSize.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          subsidyUsdc: "0.00",
          feeUsdc: allInPremium.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: passThroughCapInfoLate.capMultiplier
            ? passThroughCapInfoLate.capMultiplier.toFixed(4)
            : null,
          passThroughCapped: false,
        reason: "pass_through",
          liquidityOverride: liquidityOverrideUsed,
          replication: fallbackReplication,
          survivalCheck,
          selectionSnapshot: fallbackSnapshot,
          rollMultiplier: bestCandidate.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
        };
      }
    }

    const affordableSize = feeUsdc.div(
      bestCandidate.premiumPerUnit.mul(new Decimal(bestCandidate.rollMultiplier))
    );
    const partialSize = Decimal.min(bestCandidate.availableSize, affordableSize);
    if (partialSize.greaterThanOrEqualTo(minSize)) {
      const coverageRatio = partialSize.div(requiredSize);
      const discountedFee = applyPartialDiscount(feeUsdc, coverageRatio);
      const optionSymbol = optionType === "put" ? "P" : "C";
      const optionInstrument = buildInstrumentName(
        asset,
        bestCandidate.expiryTag,
        bestCandidate.strike.toFixed(0),
        optionSymbol
      );
      return {
        status: "partial",
        expiryTag: bestCandidate.expiryTag,
        targetDays: bestCandidate.targetDays,
        optionType,
        strike: bestCandidate.strike.toFixed(0),
        instrument: optionInstrument,
        premiumUsdc: bestCandidate.premiumPerUnit.mul(partialSize).toFixed(2),
        premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
        hedgeSize: partialSize.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: "0.00",
        markIv: feeIv.raw,
        subsidyUsdc: "0.00",
        feeUsdc: discountedFee.toFixed(2),
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: passThroughCapInfo.capMultiplier
          ? passThroughCapInfo.capMultiplier.toFixed(4)
          : null,
        passThroughCapped: passThroughCapInfo.capped,
        reason: "partial",
        liquidityOverride: liquidityOverrideUsed,
        replication: fallbackReplication,
        survivalCheck,
        selectionSnapshot: fallbackSnapshot,
        rollMultiplier: bestCandidate.rollMultiplier,
        rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
        coveragePct: coverageRatio.mul(100).toFixed(2),
        feeDiscountPct: (riskControls.partial_coverage_discount_pct ?? 0) * 100
      };
    }

    return {
      status: "perp_fallback",
      expiryTag: bestCandidate.expiryTag,
      targetDays: bestCandidate.targetDays,
      rejected,
      reason: "perp_fallback",
      liquidityOverride: liquidityOverrideUsed,
      replication: fallbackReplication,
      selectionSnapshot: fallbackSnapshot,
      rollMultiplier: bestCandidate.rollMultiplier,
      rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
    };
  }

  const quoteIv =
    Number.isFinite(quote.iv) && (quote.iv ?? 0) > 0 ? quote.iv : body.ivSnapshot;
  const durationDays = quote.targetDays ?? targetDays;
  const feeBase = await calculateFeeBase({
    tierName,
    baseFeeUsdc: new Decimal(body.fixedPriceUsdc),
    targetDays: durationDays,
    leverage,
    asset,
    ivCandidate: quoteIv
  });
  const feeIv = feeBase.feeIv;
  const baseBuffer = new Decimal(0.03);
  const leverageBuffer = new Decimal(0.005).mul(Math.max(0, leverage - 1));
  const ivBufferRaw = new Decimal(feeIv.scaled).mul(new Decimal(0.05));
  const ivBuffer = Decimal.min(Decimal.max(ivBufferRaw, new Decimal(0)), new Decimal(0.05));
  const bufferTargetPct = baseBuffer.plus(leverageBuffer).plus(ivBuffer);
  const bufferTargetPctCapped = Decimal.min(bufferTargetPct, new Decimal(0.15));

  const notionalUsdc = positionSize.mul(new Decimal(body.spotPrice)).mul(new Decimal(leverage)).toNumber();
  let feeUsdc = feeBase.feeUsdc;
  const feeRegime = feeBase.feeRegime;
  const feeLeverage = feeBase.feeLeverage;
  const ctcSafety = calculateCtcSafetyFee({
    tierName,
    drawdownPct: drawdownFloorPct,
    spotPrice,
    positionSize,
    leverage
  });
  let feeReason = "flat_fee";
  if (ctcSafety.feeUsdc && ctcSafety.feeUsdc.gt(feeUsdc)) {
    feeUsdc = ctcSafety.feeUsdc;
    feeReason = "ctc_safety";
  }
  const allInPremium = quote.allInPremium;
  const premiumFloor = premiumFloorBreached(allInPremium, feeUsdc);
  const canPassThrough = FOXIFY_APPROVED && body.allowPremiumPassThrough;
  const passThroughCapInfo = applyPassThroughCap(feeUsdc, allInPremium, leverage);
  const canFullyCoverQuote = quote.availableSize.greaterThanOrEqualTo(requiredSize);
  if (premiumFloor.breached && canPassThrough && passThroughCapInfo.capped && passThroughCapInfo.maxFee) {
    feeUsdc = passThroughCapInfo.maxFee;
    const bronzeFixedCapped = applyBronzeFixedFee(tierName, leverage, feeUsdc);
    feeUsdc = bronzeFixedCapped.fee;
    const subsidyNeeded = allInPremium.minus(feeUsdc);
    const subsidyCheck = canApplySubsidy(
      tierName,
      body.accountId || null,
      subsidyNeeded.toNumber(),
      feeIv.scaled
    );
    const optionSymbol = optionType === "put" ? "P" : "C";
    const optionInstrument = buildInstrumentName(
      asset,
      quote.expiryTag || "",
      quote.strike.toFixed(0),
      optionSymbol
    );
    if (subsidyNeeded.gt(0)) {
      const affordableSize = feeUsdc.div(
        quote.premiumPerUnit.mul(new Decimal(quote.rollMultiplier))
      );
      const partialSize = Decimal.min(quote.availableSize, affordableSize);
      if (partialSize.greaterThanOrEqualTo(minSize)) {
        const coverageRatio = partialSize.div(requiredSize);
        const discountedFee = applyPartialDiscount(feeUsdc, coverageRatio);
        return {
          status: "partial",
          optionType,
          venue: "deribit",
          strike: quote.strike.toFixed(0),
          premiumUsdc: quote.premiumPerUnit.mul(partialSize).toFixed(2),
          premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
          hedgeSize: partialSize.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          expiryTag: quote.expiryTag || "",
          targetDays: quote.targetDays || 0,
          instrument: optionInstrument,
          feeUsdc: discountedFee.toFixed(2),
          subsidyUsdc: "0.00",
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: passThroughCapInfo.capMultiplier
            ? passThroughCapInfo.capMultiplier.toFixed(4)
            : null,
          passThroughCapped: true,
          reason: "pass_through_capped_partial",
          liquidityOverride: liquidityOverrideUsed,
          replication: replicationMeta,
          survivalCheck: buildSurvivalCheck({
            spotPrice,
            drawdownFloorPct,
            optionType,
            strike: quote.strike,
            hedgeSize: partialSize,
            requiredSize,
            tolerancePct: survivalTolerance
          }),
          selectionSnapshot: bestSnapshots
            ? {
                expiryTag: quote.expiryTag,
                targetDays: quote.targetDays,
                strike: quote.strike.toFixed(0),
                books: bestSnapshots
              }
            : null,
          rollMultiplier: quote.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
          coveragePct: coverageRatio.mul(100).toFixed(2),
          feeDiscountPct: (riskControls.partial_coverage_discount_pct ?? 0) * 100
        };
      }
      if (subsidyNeeded.gt(0) && subsidyCheck.allowed && canFullyCoverQuote) {
        return {
          status: "subsidized",
          optionType,
          venue: "deribit",
          strike: quote.strike.toFixed(0),
          premiumUsdc: quote.premiumTotal.toFixed(2),
          premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
          hedgeSize: requiredSize.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          expiryTag: quote.expiryTag || "",
          targetDays: quote.targetDays || 0,
          instrument: optionInstrument,
          feeUsdc: feeUsdc.toFixed(2),
          subsidyUsdc: subsidyNeeded.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: passThroughCapInfo.capMultiplier
            ? passThroughCapInfo.capMultiplier.toFixed(4)
            : null,
          passThroughCapped: true,
          reason: "pass_through_capped_subsidized",
          liquidityOverride: liquidityOverrideUsed,
          replication: replicationMeta,
          survivalCheck: buildSurvivalCheck({
            spotPrice,
            drawdownFloorPct,
            optionType,
            strike: quote.strike,
            hedgeSize: requiredSize,
            requiredSize,
            tolerancePct: survivalTolerance
          }),
          selectionSnapshot: bestSnapshots
            ? {
                expiryTag: quote.expiryTag,
                targetDays: quote.targetDays,
                strike: quote.strike.toFixed(0),
                books: bestSnapshots
              }
            : null,
          rollMultiplier: quote.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
        };
      }
      if (subsidyNeeded.gt(0) && canFullyCoverQuote && canCoverageOverride(tierName)) {
        return {
          status: "subsidized",
          optionType,
          venue: "deribit",
          strike: quote.strike.toFixed(0),
          premiumUsdc: quote.premiumTotal.toFixed(2),
          premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
          hedgeSize: requiredSize.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          expiryTag: quote.expiryTag || "",
          targetDays: quote.targetDays || 0,
          instrument: optionInstrument,
          feeUsdc: feeUsdc.toFixed(2),
          subsidyUsdc: subsidyNeeded.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: passThroughCapInfo.capMultiplier
            ? passThroughCapInfo.capMultiplier.toFixed(4)
            : null,
          passThroughCapped: true,
          reason: "pass_through_capped_override",
          capBreached: true,
          subsidyCapReason: subsidyCheck.reason,
          liquidityOverride: liquidityOverrideUsed,
          replication: replicationMeta,
          survivalCheck: buildSurvivalCheck({
            spotPrice,
            drawdownFloorPct,
            optionType,
            strike: quote.strike,
            hedgeSize: requiredSize,
            requiredSize,
            tolerancePct: survivalTolerance
          }),
          selectionSnapshot: bestSnapshots
            ? {
                expiryTag: quote.expiryTag,
                targetDays: quote.targetDays,
                strike: quote.strike.toFixed(0),
                books: bestSnapshots
              }
            : null,
          rollMultiplier: quote.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
        };
      }
      return {
        status: "perp_fallback",
        expiryTag: quote.expiryTag || "",
        targetDays: quote.targetDays || 0,
        rejected: {
          missingBook: 0,
          spreadTooWide: 0,
          sizeTooSmall: 0,
          noBidAsk: 0,
          slippageTooHigh: 0
        },
        reason: "pass_through_capped_perp_fallback",
        liquidityOverride: liquidityOverrideUsed,
        replication: replicationMeta,
        selectionSnapshot: bestSnapshots
          ? {
              expiryTag: quote.expiryTag,
              targetDays: quote.targetDays,
              strike: quote.strike.toFixed(0),
              books: bestSnapshots
            }
          : null,
        rollMultiplier: quote.rollMultiplier,
        rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
      };
    }
  }
  const cap = riskControls.net_exposure_cap_usdc[tierName] ?? Number.POSITIVE_INFINITY;
  const state = getRiskState(tierName);

  let hedgeFactor = 1;
  if (state.overageUsdc > state.revenueUsdc * riskControls.risk_budget_pct_min) {
    hedgeFactor = Math.min(hedgeFactor, 0.8);
  }
  if (state.overageUsdc > state.revenueUsdc * riskControls.risk_budget_pct_max) {
    hedgeFactor = Math.min(hedgeFactor, 0.5);
  }
  if (state.notionalUsdc > cap) {
    hedgeFactor = Math.min(hedgeFactor, riskControls.hedge_reduction_factor);
  }
  const iv = feeIv.scaled;
  if (iv && iv > riskControls.volatility_throttle_iv) {
    hedgeFactor = Math.min(hedgeFactor, riskControls.hedge_reduction_factor);
  }
  hedgeFactor = Math.max(1, hedgeFactor);

  const optionSymbol = optionType === "put" ? "P" : "C";
  const optionInstrument = buildInstrumentName(
    asset,
    quote.expiryTag || "",
    quote.strike.toFixed(0),
    optionSymbol
  );

  const response = {
    status: "ok",
    optionType,
    venue: "deribit",
    strike: quote.strike.toFixed(0),
    premiumUsdc: quote.premiumTotal.toFixed(2),
    premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
    score: null,
    liquidityOverride: liquidityOverrideUsed,
    hedgeSize: (() => {
      const adjusted = hedgeSize.mul(hedgeFactor);
      const available = quote.availableSize;
      return capHedgeSize(adjusted, available).toFixed(4);
    })(),
    sizingMethod: body.optionDelta ? "delta" : "notional",
    bufferTargetPct: bufferTargetPctCapped.toFixed(4),
    markIv: feeIv.raw,
    expiryTag: quote.expiryTag || "",
    targetDays: quote.targetDays || 0,
    instrument: optionInstrument,
    executionPlan: chosenExecutionPlans
      ? chosenExecutionPlans.map((plan) => ({
          venue: plan.venue,
          instrument: plan.instrument,
          side: plan.side,
          size: plan.size.toFixed(6),
          price: plan.price.toFixed(6)
        }))
      : null
  };
  const survivalCheck = buildSurvivalCheck({
    spotPrice,
    drawdownFloorPct,
    optionType,
    strike: quote.strike,
    hedgeSize: new Decimal(response.hedgeSize),
    requiredSize,
    tolerancePct: survivalTolerance
  });
  const selectedSnapshot = bestSnapshots
    ? {
        expiryTag: quote.expiryTag,
        targetDays: quote.targetDays,
        strike: quote.strike.toFixed(0),
        books: bestSnapshots
      }
    : null;
  response["replication"] = replicationMeta;
  response["survivalCheck"] = survivalCheck;
  response["selectionSnapshot"] = selectedSnapshot;
  response["rollMultiplier"] = quote.rollMultiplier;
  response["rollEstimatedPremiumUsdc"] = allInPremium.toFixed(2);
  response["feeUsdc"] = feeUsdc.toFixed(2);
  response["feeRegime"] = feeRegime.regime;
  response["feeRegimeMultiplier"] = feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null;
  response["feeLeverageMultiplier"] = feeLeverage.multiplier
    ? feeLeverage.multiplier.toFixed(4)
    : null;
  const quotePassThroughCap = applyPassThroughCap(feeUsdc, allInPremium, leverage);
  response["passThroughCapMultiplier"] = quotePassThroughCap.capMultiplier
    ? quotePassThroughCap.capMultiplier.toFixed(4)
    : null;
  response["passThroughCapped"] = quotePassThroughCap.capped;
  response["subsidyUsdc"] = "0.00";
  response["reason"] = feeReason;
  if (premiumFloor.breached) {
    if (canPassThrough && !quotePassThroughCap.capped) {
      response["status"] = "pass_through";
      response["feeUsdc"] = allInPremium.toFixed(2);
      response["reason"] = "premium_floor_pass_through";
    } else {
      response["status"] = "premium_floor";
      response["reason"] = quotePassThroughCap.capped
        ? "premium_floor_pass_through_capped"
        : "premium_floor";
    }
    response["warning"] = {
      type: "premium_floor",
      ratio: premiumFloor.ratio.toFixed(4),
      threshold: premiumFloor.threshold.toFixed(4)
    };
  }
  await audit("put_quote", response);
  setQuoteCache(cacheKey, response);
  return response;
});

function buildInstrumentName(currency: string, expiryTag: string, strike: string, type: "P" | "C"): string {
  return `${currency}-${expiryTag}-${strike}-${type}`;
}

function deriveExpiryTag(instrumentName: string): string {
  const parts = instrumentName.split("-");
  return parts.length >= 2 ? parts[1] : "";
}

function targetDaysForExpiryTag(
  instruments: Array<any>,
  expiryTag: string
): number | null {
  if (!expiryTag) return null;
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  let earliestExpiry: number | null = null;
  for (const inst of instruments) {
    if (!inst.expiration_timestamp || !inst.instrument_name?.includes(expiryTag)) continue;
    if (earliestExpiry === null || inst.expiration_timestamp < earliestExpiry) {
      earliestExpiry = inst.expiration_timestamp;
    }
  }
  if (earliestExpiry === null) return null;
  const diffMs = earliestExpiry - now;
  if (!Number.isFinite(diffMs)) return null;
  return Math.max(1, Math.ceil(diffMs / msPerDay));
}


async function closestExpiryTag(daysTarget = 1): Promise<string> {
  const instruments = await deribit.listInstruments("BTC");
  const results = (instruments as any)?.result || [];
  const now = Date.now();
  const targetMs = daysTarget * 24 * 60 * 60 * 1000;

  let bestTag = "";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const inst of results) {
    if (!inst.expiration_timestamp || inst.option_type !== "put") continue;
    const diff = Math.abs(inst.expiration_timestamp - now - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestTag = deriveExpiryTag(inst.instrument_name || "");
    }
  }

  return bestTag;
}

async function closestExpiryTagForTarget(
  instruments: Array<any>,
  daysTarget: number
): Promise<string> {
  const now = Date.now();
  const targetMs = daysTarget * 24 * 60 * 60 * 1000;
  let bestTag = "";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const inst of instruments) {
    if (!inst.expiration_timestamp || inst.option_type !== "put") continue;
    const diff = Math.abs(inst.expiration_timestamp - now - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestTag = deriveExpiryTag(inst.instrument_name || "");
    }
  }
  return bestTag;
}

async function closestExpiryTagFallback(
  targets: number[]
): Promise<{ expiryTag: string; targetDays: number }> {
  for (const days of targets) {
    const expiryTag = await closestExpiryTag(days);
    if (expiryTag) return { expiryTag, targetDays: days };
  }
  return { expiryTag: "", targetDays: targets[0] || 1 };
}

app.post("/put/auto-renew", async (req) => {
  const body = req.body as {
    tierName?: string;
    asset?: string;
    spotPrice: number;
    drawdownFloorPct: number;
    fixedPriceUsdc: number;
    expiryTag?: string;
    targetDays?: number;
    amount: number;
    renewWindowMinutes?: number;
    expiryIso?: string;
    side?: "long" | "short";
    coverageId?: string;
    accountId?: string;
    allowPremiumPassThrough?: boolean;
  };

  if (body.expiryIso && body.renewWindowMinutes) {
    const expiry = new Date(body.expiryIso);
    const renewAt = new Date(expiry.getTime() - body.renewWindowMinutes * 60 * 1000);
    if (Date.now() < renewAt.getTime()) {
      const response = { status: "too_early", renewAt: renewAt.toISOString() };
      await audit("put_renew_skipped", response);
      return response;
    }
  }

  const asset = (body.asset || "BTC").toUpperCase();
  if (asset !== "BTC") {
    return { status: "no_quote", reason: "unsupported_asset" };
  }
  const instruments = await deribit.listInstruments(asset);
  const results = (instruments as any)?.result || [];
  const optionType = body.side === "short" ? "call" : "put";
  const baseMaxSpreadPct = riskControls.max_spread_pct ?? 0.05;
  const baseMaxSlippagePct = riskControls.max_slippage_pct ?? 0.01;
  const useBodySpread = false;
  const useBodySlippage = false;
  const requiredSize = new Decimal(body.amount ?? 0);
  const spotPrice = new Decimal(body.spotPrice);
  const drawdownFloorPct = new Decimal(body.drawdownFloorPct);
  const tierName = body.tierName || "Unknown";
  const expiryTargetDays = body.expiryTag
    ? targetDaysForExpiryTag(results, body.expiryTag)
    : null;
  const defaultTargetDays = riskControls.default_target_days ?? 7;
  const maxPreferredDays = riskControls.max_target_days ?? 7;
  const maxFallbackDays = riskControls.fallback_target_days ?? 14;
  const targetDays = Math.min(
    maxFallbackDays,
    Math.max(1, Math.round(body.targetDays ?? expiryTargetDays ?? defaultTargetDays))
  );
  const expirySearchOrder = body.expiryTag
    ? [{ expiryTag: body.expiryTag, targetDays: expiryTargetDays ?? targetDays }]
    : await buildExpirySearchOrder(
        results,
        optionType,
        spotPrice,
        drawdownFloorPct,
        requiredSize,
        new Decimal(baseMaxSpreadPct ?? 0.05),
        targetDays,
        maxPreferredDays,
        maxFallbackDays
      );
  let chosenExecutionPlans:
    | Array<{ venue: string; instrument: string; side: "buy" | "sell"; size: Decimal; price: Decimal }>
    | null = null;
  let chosenSnapshots: Map<string, QuoteBookSnapshot[]> | null = null;
  let bestCandidate: {
    expiryTag: string;
    targetDays: number;
    premiumPerUnit: Decimal;
    premiumTotal: Decimal;
    availableSize: Decimal;
    strike: Decimal;
    iv?: number;
    spreadPct: Decimal;
    rollMultiplier: number;
    allInPremium: Decimal;
  } | null = null;
  let bestSnapshots: QuoteBookSnapshot[] | null = null;
  const liquidityOverrideEnabled = riskControls.liquidity_override_enabled ?? false;
  let liquidityOverrideUsed = false;

  for (const overridePass of [false, true]) {
    if (overridePass && !liquidityOverrideEnabled) break;
    bestCandidate = null;
    bestSnapshots = null;
    chosenExecutionPlans = null;
    chosenSnapshots = null;

    for (const entry of expirySearchOrder) {
      const expiryTag = entry.expiryTag;
      const days = entry.targetDays;
      if (!expiryTag) continue;
      const plansByStrike = new Map<
        string,
        Array<{ venue: string; instrument: string; side: "buy" | "sell"; size: Decimal; price: Decimal }>
      >();
      const snapshotsByStrike = new Map<string, QuoteBookSnapshot[]>();
      const strikeCandidates = selectStrikeCandidates(
        results,
        expiryTag,
        optionType,
        spotPrice,
        drawdownFloorPct,
        30
      );
      const { maxSpreadPct, maxSlippagePct } = resolveLiquidityThresholds(
        days,
        overridePass,
        baseMaxSpreadPct ?? 0.05,
        baseMaxSlippagePct ?? 0.01,
        useBodySpread,
        useBodySlippage
      );

      for (const inst of strikeCandidates) {
        const quotes = await getOptionVenueQuotes(inst.instrument_name, spotPrice);
        if (!quotes.length) continue;
        const snapshots = quotes.map((quote) => ({
          venue: quote.venue,
          instrument: quote.instrument,
          bidUsd: serializeDecimal(quote.book.bid, 6),
          askUsd: serializeDecimal(quote.book.ask, 6),
          bidSize: serializeDecimal(quote.book.bidSize, 6) ?? "0",
          askSize: serializeDecimal(quote.book.askSize, 6) ?? "0",
          spreadPct: serializeDecimal(quote.book.spreadPct, 6) ?? "0",
          timestampMs: quote.book.timestampMs ?? null,
          markPriceUsd: serializeDecimal(quote.book.markPriceUsd, 6)
        }));
        snapshotsByStrike.set(new Decimal(inst.strike).toFixed(0), snapshots);
        const agg = aggregateOptionQuotes(quotes, "buy", requiredSize);
        if (!agg.bestBid || !agg.bestAsk) continue;
        if (agg.spread.gt(maxSpreadPct)) continue;
        if (!agg.avgPrice || agg.filledSize.lte(0)) continue;
        const slippagePct = agg.avgPrice.minus(agg.bestAsk).div(agg.bestAsk);
        if (slippagePct.gt(maxSlippagePct)) continue;

        const ticker = await deribit.getTicker(inst.instrument_name);
        const iv = Number((ticker as any)?.result?.mark_iv ?? 0);
        const premiumPerUnit = agg.avgPrice;
        const premiumTotal = premiumPerUnit.mul(requiredSize);
        const rollMultiplier = Math.max(1, Math.ceil(targetDays / days));
        const allInPremium = premiumTotal.mul(new Decimal(rollMultiplier));
        if (!bestCandidate || allInPremium.lt(bestCandidate.allInPremium)) {
          bestCandidate = {
            expiryTag,
            targetDays: days,
            premiumPerUnit,
            premiumTotal,
            availableSize: agg.totalAskSize,
            strike: new Decimal(inst.strike),
            iv,
            spreadPct: agg.spread,
            rollMultiplier,
            allInPremium
          };
          bestSnapshots = snapshots;
          chosenExecutionPlans = agg.plans;
          chosenSnapshots = snapshotsByStrike;
        }
        plansByStrike.set(new Decimal(inst.strike).toFixed(0), agg.plans);
      }
    }

    if (bestCandidate) {
      liquidityOverrideUsed = overridePass;
      break;
    }
  }

  const quote = bestCandidate;
  const survivalTolerance = new Decimal(
    riskControls.survival_tolerance_pct ?? 0.98
  );
  const replicationMeta = quote
    ? buildReplicationMeta({
        targetDays: quote.targetDays,
        maxPreferredDays,
        optionType
      })
    : null;

  let renewReason = "flat_fee";
  let subsidyUsdc = new Decimal(0);
  let effectiveFeeUsdc = new Decimal(body.fixedPriceUsdc);
  let effectiveSize = requiredSize;
  let effectiveExpiryTag = quote?.expiryTag || body.expiryTag || "";
  let effectiveStrike: Decimal | null = quote?.strike ?? null;
  let effectivePremiumUsdc = quote?.premiumTotal ?? new Decimal(0);
  let effectiveAllInPremium = quote?.allInPremium ?? new Decimal(0);
  let effectiveRollMultiplier = quote?.rollMultiplier ?? 1;
  let effectiveIv = 0;
  let effectiveAvailableSize = quote?.availableSize ?? null;
  let renewalReplication: Record<string, unknown> | null = replicationMeta;
  let renewalSurvivalCheck: ReturnType<typeof buildSurvivalCheck> | null = quote
    ? buildSurvivalCheck({
        spotPrice,
        drawdownFloorPct,
        optionType,
        strike: quote.strike,
        hedgeSize: requiredSize,
        requiredSize,
        tolerancePct: survivalTolerance
      })
    : null;
  let renewalSnapshot: Record<string, unknown> | null = null;

  if (!quote) {
    await audit("put_renew_failed", { reason: "no_quote", liquidityOverride: liquidityOverrideUsed });
    return { status: "no_quote", liquidityOverride: liquidityOverrideUsed };
  }
  const leverageCheck = normalizeLeverage(body.leverage);
  if (!leverageCheck.ok) {
    return {
      status: "no_quote",
      reason: "invalid_leverage",
      maxLeverage: leverageCheck.max,
      liquidityOverride: liquidityOverrideUsed
    };
  }
  const renewLeverage = leverageCheck.value;
  const renewDurationDays = quote?.targetDays ?? targetDays;
  const renewFeeBase = await calculateFeeBase({
    tierName,
    baseFeeUsdc: new Decimal(body.fixedPriceUsdc),
    targetDays: renewDurationDays,
    leverage: renewLeverage,
    asset,
    ivCandidate: quote?.iv
  });
  effectiveFeeUsdc = renewFeeBase.feeUsdc;
  const renewFeeRegime = renewFeeBase.feeRegime;
  const renewFeeLeverage = renewFeeBase.feeLeverage;
  effectiveIv = renewFeeBase.feeIv.scaled;
  const renewSafety = calculateCtcSafetyFee({
    tierName,
    drawdownPct: drawdownFloorPct,
    spotPrice,
    positionSize: requiredSize,
    leverage: renewLeverage
  });
  if (renewSafety.feeUsdc && renewSafety.feeUsdc.gt(effectiveFeeUsdc)) {
    effectiveFeeUsdc = renewSafety.feeUsdc;
    renewReason = "ctc_safety";
  }
  const renewPremiumFloor = premiumFloorBreached(effectiveAllInPremium, effectiveFeeUsdc);
  const renewCanPassThrough = FOXIFY_APPROVED && body.allowPremiumPassThrough;
  let subsidyNeeded = effectiveAllInPremium.minus(effectiveFeeUsdc);
  let subsidyCheck = canApplySubsidy(
    tierName,
    body.accountId || null,
    subsidyNeeded.toNumber(),
    effectiveIv
  );
  const renewPassThroughCap = applyPassThroughCap(
    effectiveFeeUsdc,
    effectiveAllInPremium,
    renewLeverage
  );
  const canFullyCover = effectiveAvailableSize
    ? effectiveAvailableSize.greaterThanOrEqualTo(requiredSize)
    : false;
  if (renewPremiumFloor.breached && renewReason !== "pass_through") {
    if (renewCanPassThrough && !renewPassThroughCap.capped) {
      renewReason = "pass_through";
      effectiveFeeUsdc = effectiveAllInPremium;
    } else if (renewCanPassThrough && renewPassThroughCap.capped && renewPassThroughCap.maxFee) {
      renewReason = "pass_through_capped";
      effectiveFeeUsdc = renewPassThroughCap.maxFee;
      subsidyNeeded = effectiveAllInPremium.minus(effectiveFeeUsdc);
      subsidyCheck = canApplySubsidy(
        tierName,
        body.accountId || null,
        subsidyNeeded.toNumber(),
        effectiveIv
      );
    } else {
      return {
        status: "premium_floor",
        reason: renewPassThroughCap.capped
          ? "premium_floor_pass_through_capped"
          : "premium_floor",
        liquidityOverride: liquidityOverrideUsed,
        feeRegime: renewFeeRegime.regime,
        feeRegimeMultiplier: renewFeeRegime.multiplier
          ? renewFeeRegime.multiplier.toFixed(4)
          : null,
        feeLeverageMultiplier: renewFeeLeverage.multiplier
          ? renewFeeLeverage.multiplier.toFixed(4)
          : null,
        passThroughCapMultiplier: renewPassThroughCap.capMultiplier
          ? renewPassThroughCap.capMultiplier.toFixed(4)
          : null,
        passThroughCapped: renewPassThroughCap.capped,
        warning: {
          type: "premium_floor",
          ratio: renewPremiumFloor.ratio.toFixed(4),
          threshold: renewPremiumFloor.threshold.toFixed(4)
        }
      };
    }
  }
  if (renewReason !== "pass_through") {
    if (renewReason === "pass_through_capped" && subsidyNeeded.gt(0)) {
      const minSize = new Decimal(riskControls.min_option_size ?? 0.01);
      const affordableSize = effectiveFeeUsdc.div(
        quote.premiumPerUnit.mul(new Decimal(effectiveRollMultiplier))
      );
      const partialSize = Decimal.min(quote.availableSize, affordableSize);
      if (partialSize.greaterThanOrEqualTo(minSize)) {
        renewReason = "partial";
        effectiveSize = partialSize;
        effectivePremiumUsdc = quote.premiumPerUnit.mul(partialSize);
        effectiveFeeUsdc = applyPartialDiscount(
          effectiveFeeUsdc,
          partialSize.div(requiredSize)
        );
      }
    }
    if (renewReason !== "partial") {
      if (subsidyNeeded.gt(0) && subsidyCheck.allowed && canFullyCover) {
        renewReason = "subsidized";
        subsidyUsdc = subsidyNeeded;
      } else if (subsidyNeeded.gt(0) && canFullyCover && canCoverageOverride(tierName)) {
        renewReason = "coverage_override";
        subsidyUsdc = subsidyNeeded;
      } else if (renewCanPassThrough && effectiveAllInPremium.gt(effectiveFeeUsdc)) {
        const lateCap = applyPassThroughCap(
          effectiveFeeUsdc,
          effectiveAllInPremium,
          renewLeverage
        );
        if (!lateCap.capped) {
          renewReason = "pass_through";
          effectiveFeeUsdc = effectiveAllInPremium;
        } else if (lateCap.maxFee) {
          renewReason = "pass_through_capped";
          effectiveFeeUsdc = lateCap.maxFee;
          subsidyNeeded = effectiveAllInPremium.minus(effectiveFeeUsdc);
          subsidyCheck = canApplySubsidy(
            tierName,
            body.accountId || null,
            subsidyNeeded.toNumber(),
            effectiveIv
          );
        }
      } else if (subsidyNeeded.gt(0)) {
        const minSize = new Decimal(riskControls.min_option_size ?? 0.01);
        const affordableSize = effectiveFeeUsdc.div(
          quote.premiumPerUnit.mul(new Decimal(effectiveRollMultiplier))
        );
        const partialSize = Decimal.min(quote.availableSize, affordableSize);
        if (partialSize.greaterThanOrEqualTo(minSize)) {
          renewReason = "partial";
          effectiveSize = partialSize;
          effectivePremiumUsdc = quote.premiumPerUnit.mul(partialSize);
          effectiveFeeUsdc = applyPartialDiscount(
            effectiveFeeUsdc,
            partialSize.div(requiredSize)
          );
        } else {
          await audit("put_renew_failed", { reason: "perp_fallback" });
          return { status: "perp_fallback" };
        }
      }
    }
  }
  const feeUsdc = Number(effectiveFeeUsdc.toFixed(2));
  const premiumUsdc = Number(effectivePremiumUsdc.toFixed(2));
  const cap = riskControls.net_exposure_cap_usdc[tierName] ?? Number.POSITIVE_INFINITY;

  let hedgeFactor = 1;
  const state = getRiskState(tierName);
  if (state.overageUsdc > state.revenueUsdc * riskControls.risk_budget_pct_min) {
    hedgeFactor = Math.min(hedgeFactor, 0.8);
  }
  if (state.overageUsdc > state.revenueUsdc * riskControls.risk_budget_pct_max) {
    hedgeFactor = Math.min(hedgeFactor, 0.5);
  }
  if (state.notionalUsdc > cap) {
    hedgeFactor = Math.min(hedgeFactor, riskControls.hedge_reduction_factor);
  }
  const iv = effectiveIv ?? 0;
  if (iv && iv > riskControls.volatility_throttle_iv) {
    hedgeFactor = Math.min(hedgeFactor, riskControls.hedge_reduction_factor);
  }

  const optionSymbol = optionType === "put" ? "P" : "C";
  const optionInstrument = buildInstrumentName(
    asset,
    effectiveExpiryTag,
    (effectiveStrike ?? new Decimal(0)).toFixed(0),
    optionSymbol
  );

  const desiredAmount = effectiveSize.mul(hedgeFactor);
  const cappedAmount = capHedgeSize(desiredAmount, effectiveAvailableSize ?? undefined);
  const notionalUsdc = cappedAmount.mul(new Decimal(body.spotPrice)).toNumber();
  const finalSurvivalCheck = buildSurvivalCheck({
    spotPrice,
    drawdownFloorPct,
    optionType,
    strike: effectiveStrike,
    hedgeSize: cappedAmount,
    requiredSize: effectiveSize,
    tolerancePct: survivalTolerance
  });
  if (finalSurvivalCheck) {
    renewalSurvivalCheck = finalSurvivalCheck;
  }
  const buyOption = await executionRegistry.placeOrder("deribit", {
    instrument: optionInstrument,
    amount: cappedAmount.toNumber(),
    side: "buy",
    type: "market"
  });

  const renewStatus = String((buyOption as any)?.status || "");
  const renewFill =
    (buyOption as any)?.result?.average_price ??
    (buyOption as any)?.result?.price ??
    (buyOption as any)?.fillPrice ??
    null;
  const renewPremiumUsdc = renewFill
    ? Number(new Decimal(renewFill).mul(new Decimal(body.spotPrice)).mul(cappedAmount))
    : null;
  if (!renewalSnapshot && quote && effectiveStrike) {
    const strikeKey = effectiveStrike.toFixed(0);
    renewalSnapshot = {
      expiryTag: quote.expiryTag,
      targetDays: quote.targetDays,
      strike: strikeKey,
      books: chosenSnapshots?.get(strikeKey) ?? []
    };
  }

  const response = {
    status: renewReason,
    venue: "deribit",
    replication: renewalReplication,
    survivalCheck: renewalSurvivalCheck,
    selectionSnapshot: renewalSnapshot,
    rollMultiplier: effectiveRollMultiplier,
    rollEstimatedPremiumUsdc: effectiveAllInPremium.toFixed(2),
    liquidityOverride: liquidityOverrideUsed,
    subsidyUsdc: subsidyUsdc.toFixed(2),
    feeUsdc: effectiveFeeUsdc.toFixed(2),
    feeRegime: renewFeeRegime.regime,
    feeRegimeMultiplier: renewFeeRegime.multiplier
      ? renewFeeRegime.multiplier.toFixed(4)
      : null,
    feeLeverageMultiplier: renewFeeLeverage.multiplier
      ? renewFeeLeverage.multiplier.toFixed(4)
      : null,
    passThroughCapMultiplier: renewPassThroughCap.capMultiplier
      ? renewPassThroughCap.capMultiplier.toFixed(4)
      : null,
    passThroughCapped: renewPassThroughCap.capped,
    capBreached: renewReason === "coverage_override",
    executionPlan: chosenExecutionPlans
      ? chosenExecutionPlans.map((plan) => ({
          venue: plan.venue,
          instrument: plan.instrument,
          side: plan.side,
          size: plan.size.toFixed(6),
          price: plan.price.toFixed(6)
        }))
      : null,
    quote: {
      strike: (effectiveStrike ?? new Decimal(0)).toFixed(0),
      premiumUsdc: effectivePremiumUsdc.toFixed(2)
    },
    orders: { buyOption }
  };
  await audit("hedge_order", {
    instrument: optionInstrument,
    side: "buy",
    amount: cappedAmount.toNumber(),
    type: "market",
    coverageId: body.coverageId || null,
    notionalUsdc,
    hedgeType: "option",
    status: renewStatus || "submitted",
    fillPrice: renewFill,
    premiumUsdc: renewPremiumUsdc ?? effectivePremiumUsdc.toFixed(2),
    feeUsdc,
    subsidyUsdc: subsidyUsdc.toFixed(2),
    reason: renewReason,
    venue: "deribit"
  });
  if (renewStatus === "paper_filled" || renewStatus === "filled" || renewStatus === "ok") {
    const accounting = applyRiskAccounting(
      tierName,
      feeUsdc,
      Number(renewPremiumUsdc ?? effectivePremiumUsdc.toFixed(2)),
      notionalUsdc
    );
    await audit("liquidity_update", {
      coverageId: body.coverageId || null,
      tier: tierName,
      feeUsdc,
      premiumUsdc: renewPremiumUsdc ?? Number(effectivePremiumUsdc.toFixed(2)),
      subsidyUsdc: subsidyUsdc.toFixed(2),
      notionalUsdc,
      delta: accounting.liquidityDelta,
      totals: liquiditySummary()
    });
    if (subsidyUsdc.gt(0)) {
      recordSubsidy(tierName, body.accountId || null, subsidyUsdc.toNumber());
    }
  }
  await audit("coverage_renewed", {
    tier: tierName,
    expiryIso: body.expiryIso,
    instrument: optionInstrument,
    coverageId: body.coverageId || null
  });
  await audit("put_renew", response);
  return response;
});

app.post("/put/auto-renew/schedule", async (req) => {
  const body = req.body as {
    enabled: boolean;
    nextExpiryIso: string;
    renewWindowMinutes: number;
    payload: Record<string, unknown>;
  };

  const result = await runAutoRenewJob(body, deribit, async (payload) => {
    const renewReq = payload as any;
    return app.inject({
      method: "POST",
      url: "/put/auto-renew",
      payload: renewReq
    });
  });
  await audit("put_renew_schedule", { status: "checked" });
  return result;
});

app.get("/risk/daily-summary", async () => {
  return riskSummary();
});

app.post("/loop/tick", async (req) => {
  const body = req.body as {
    accountId: string;
    drawdownLimitUsdc: string;
    initialBalanceUsdc: string;
    hedgeInstrument: string;
    hedgeSize: number;
    bufferTargetPct: number;
    hysteresisPct: number;
    expiryIso: string;
    renewWindowMinutes: number;
    renewPayload: Record<string, unknown>;
    alertWebhookUrl?: string;
    coverageId?: string;
    notionalUsdc?: number;
    hedgeType?: string;
    tierName?: string;
    assets?: string[];
    spotByAsset?: Record<string, number>;
    exposures?: Array<{
      asset: string;
      side: "long" | "short";
      entryPrice: number;
      size: number;
      leverage: number;
    }>;
  };

  const combined = getCombinedExposureBook();
  const baseExposures =
    combined.exposures.length > 0 ? combined.exposures : body.exposures ?? [];
  const assetsFromExposure = Array.from(new Set(baseExposures.map((pos) => pos.asset)));
  const assets = ["BTC"];
  const assetsQuery = assets ? `&assets=${encodeURIComponent(assets.join(","))}` : "";
  const risk = await app.inject({
    method: "GET",
    url: `/risk/summary?drawdownLimitUsdc=${encodeURIComponent(
      body.drawdownLimitUsdc
    )}&initialBalanceUsdc=${encodeURIComponent(body.initialBalanceUsdc)}&cashUsdc=${encodeURIComponent(
      body.initialBalanceUsdc
    )}&positionPnlUsdc=0&hedgeMtmUsdc=0${assetsQuery}`
  });

  const riskPayload = risk.json() as {
    drawdownBufferPct: string;
  };

  const decision = evaluateRollingHedge({
    bufferPct: new Decimal(riskPayload.drawdownBufferPct).div(100),
    hedgeState: {
      bufferTargetPct: new Decimal(body.bufferTargetPct),
      hysteresisPct: new Decimal(body.hysteresisPct)
    },
    expiryIso: body.expiryIso,
    renewWindowMinutes: body.renewWindowMinutes
  });

  let renewalResult: unknown = { status: "skipped" };
  if (decision.renew) {
    renewalResult = await runAutoRenewJob(
      {
        enabled: true,
        nextExpiryIso: body.expiryIso,
        renewWindowMinutes: body.renewWindowMinutes,
        payload: body.renewPayload
      },
      deribit,
      async (payload) => {
        const renewReq = payload as any;
        return app.inject({
          method: "POST",
          url: "/put/auto-renew",
          payload: renewReq
        });
      }
    );
  }

  if (decision.hedgeAction === "increase") {
    await audit("hedge_action", {
      action: "increase",
      reason: decision.reason,
      instrument: body.hedgeInstrument,
      size: body.hedgeSize,
      coverageId: body.coverageId || null,
      notionalUsdc: body.notionalUsdc ?? null,
      hedgeType: body.hedgeType || "option"
    });
    await executionRegistry.placeOrder("deribit", {
      instrument: body.hedgeInstrument,
      amount: body.hedgeSize,
      side: "buy",
      type: "market"
    });
    await audit("hedge_order", {
      instrument: body.hedgeInstrument,
      side: "buy",
      amount: body.hedgeSize,
      type: "market",
      coverageId: body.coverageId || null,
      notionalUsdc: body.notionalUsdc ?? null,
      hedgeType: body.hedgeType || "option"
    });
  }

  if (baseExposures.length > 0) {
    const exposures = baseExposures.filter((pos) => pos.asset === "BTC");
    const coverageIds = ["platform-risk"];
    const netExposure = calculateNetExposure(
      exposures.map((pos) => ({
        asset: pos.asset,
        side: pos.side,
        entryPrice: new Decimal(pos.entryPrice),
        size: new Decimal(pos.size),
        leverage: new Decimal(pos.leverage)
      }))
    );
    const prediction = await predictionEngine.getSignals("net");
    const plans = await netHedgingEngine.planHedge(netExposure, prediction);
    const tierName = body.tierName || "Unknown";
    const state = getRiskState(tierName);
    const liquidity = liquiditySummary();
    for (const plan of plans) {
      const spotOverride = body.spotByAsset?.[plan.asset];
      let spotPrice = Number(spotOverride || 0);
      if (!spotPrice) {
        const indexName = `${plan.asset.toLowerCase()}_usd`;
        const spot = await deribit.getIndexPrice(indexName);
        spotPrice = Number((spot as any)?.result?.index_price || 0);
      }
      if (!spotPrice) continue;
      const sizeUnits = plan.targetNotional.div(new Decimal(spotPrice));
      const instrument = `${plan.asset}-PERPETUAL`;
      let hedgeFactor = new Decimal(1);
      if (state.overageUsdc > state.revenueUsdc * riskControls.risk_budget_pct_min) {
        hedgeFactor = Decimal.min(hedgeFactor, new Decimal(0.8));
      }
      if (state.overageUsdc > state.revenueUsdc * riskControls.risk_budget_pct_max) {
        hedgeFactor = Decimal.min(hedgeFactor, new Decimal(0.5));
      }

      const ticker = await deribit.getTicker(instrument);
      const fundingRate =
        Number((ticker as any)?.result?.funding_8h ?? (ticker as any)?.result?.current_funding ?? 0) ||
        0;
      const drawdownBuffer = new Decimal(riskPayload.drawdownBufferPct).div(100);
      if (fundingRate < -0.0005 && drawdownBuffer.greaterThan(plan.bufferTargetPct)) {
        hedgeFactor = Decimal.min(hedgeFactor, new Decimal(0.5));
      }

      const exposureFactor = new Decimal(0.7);
      const targetUnits = sizeUnits.abs().mul(hedgeFactor).mul(exposureFactor);
      if (targetUnits.lte(0)) continue;

      const reservePct = riskControls.reserve_pct ?? 0.3;
      const reserveBuffer = reservePct * liquidity.liquidityBalanceUsdc;
      const liquidityBudget = Math.max(0, liquidity.liquidityBalanceUsdc - reserveBuffer);
      const revenueBudget = Math.max(
        0,
        liquidity.revenueUsdc * riskControls.risk_budget_pct_max - liquidity.hedgeSpendUsdc
      );
      const hedgeBudgetRemaining = Math.max(liquidityBudget, revenueBudget);

      const maxPreferredDays = riskControls.max_target_days ?? 7;
      const maxFallbackDays = riskControls.fallback_target_days ?? 14;
      const netTargetDays = Math.min(
        maxFallbackDays,
        Math.max(1, Math.round(riskControls.default_target_days ?? 7))
      );
      const preferredDays = buildDayLadder(netTargetDays, maxPreferredDays, maxFallbackDays);
      const optionType = plan.targetNotional.gt(0) ? "put" : "call";
      const drawdownPct = new Decimal(1).minus(
        new Decimal(body.drawdownLimitUsdc).div(new Decimal(body.initialBalanceUsdc))
      );
      const strikeTarget =
        optionType === "put"
          ? new Decimal(spotPrice).mul(new Decimal(1).minus(drawdownPct))
          : new Decimal(spotPrice).mul(new Decimal(1).plus(drawdownPct));
      const strikeFloor = strikeTarget.mul(new Decimal(0.88));
      const strikeCeil = strikeTarget.mul(new Decimal(1.12));

      const recoverableMarginUsdc = plan.targetNotional
        .abs()
        .mul(hedgeFactor)
        .mul(new Decimal(0.0015))
        .toNumber();
      const effectiveBudget = hedgeBudgetRemaining + recoverableMarginUsdc;

      let optionChosen: {
        instrument: string;
        ask: number;
        strike: number;
        expiryTag: string;
        sizeUnits: Decimal;
        premiumUsd: Decimal;
      } | null = null;
      const optionCandidates: Array<{
        instrument: string;
        ask: number;
        strike: number;
        expiryTag: string;
        sizeUnits: Decimal;
        premiumUsd: Decimal;
        distancePct: Decimal;
        spread: Decimal;
      }> = [];

      const instruments = await deribit.listInstruments(plan.asset);
      const results = (instruments as any)?.result || [];
      const minSize = new Decimal(0.001);
      const maxSpread = Decimal.min(
        new Decimal(0.3),
        new Decimal(riskControls.max_spread_pct ?? 0.05).plus(prediction.volatilityScore.mul(0.1))
      );
      const maxSlippagePct = new Decimal(riskControls.max_slippage_pct ?? 0.01);

      const diag = {
        daysTried: 0,
        noExpiry: 0,
        noCandidates: 0,
        noBook: 0,
        noBidAsk: 0,
        spreadTooWide: 0,
        sizeTooSmall: 0,
        budgetTooSmall: 0,
        slippageTooHigh: 0,
        timeBudgetHit: 0
      };

      const searchStartedAt = Date.now();
      const searchBudgetMs = riskControls.option_search_budget_ms ?? 1200;
      for (const days of preferredDays) {
        if (Date.now() - searchStartedAt > searchBudgetMs) {
          diag.timeBudgetHit += 1;
          break;
        }
        const expiryTag = await closestExpiryTag(days);
        if (!expiryTag) {
          diag.noExpiry += 1;
          continue;
        }
        const candidates = results.filter((inst: any) => {
          if (!inst.instrument_name?.includes(expiryTag)) return false;
          if (inst.option_type !== optionType) return false;
          const strike = new Decimal(inst.strike);
          return strike.greaterThanOrEqualTo(strikeFloor) && strike.lessThanOrEqualTo(strikeCeil);
        });
        if (!candidates.length) {
          diag.noCandidates += 1;
          continue;
        }
        const sorted = candidates
          .map((inst: any) => ({
            inst,
            distance: Math.abs(Number(inst.strike) - Number(strikeTarget))
          }))
          .sort((a: any, b: any) => a.distance - b.distance)
          .slice(0, 3);
        diag.daysTried += 1;
        const ranked: Array<{
          inst: any;
          ask: number;
          bid: number;
          askSize: Decimal;
          spread: Decimal;
          fillUnits: Decimal;
          premiumUsd: Decimal;
          distancePct: Decimal;
        }> = [];
        for (const pick of sorted) {
          if (Date.now() - searchStartedAt > searchBudgetMs) {
            diag.timeBudgetHit += 1;
            break;
          }
          const book = await deribit.getOrderBook(pick.inst.instrument_name);
          const orderBook = (book as any)?.result;
          if (!orderBook) {
            diag.noBook += 1;
            continue;
          }
          const { bid, ask } = bestBidAsk(orderBook);
          if (!bid || !ask) {
            diag.noBidAsk += 1;
            continue;
          }
          const spread = spreadPct(bid, ask);
          if (spread.gt(maxSpread)) {
            diag.spreadTooWide += 1;
            continue;
          }
          const depth = estimateAverageFill(orderBook, "buy", targetUnits);
          if (!depth.avgPrice) {
            diag.noBidAsk += 1;
            continue;
          }
          const budgetUnits = new Decimal(effectiveBudget)
            .div(depth.avgPrice.mul(new Decimal(spotPrice)));
          const fillUnits = Decimal.min(depth.filledSize, targetUnits, budgetUnits);
          const askSize = new Decimal(orderBook.asks?.[0]?.[1] || 0);
          if (fillUnits.lt(minSize)) {
            diag.sizeTooSmall += 1;
            continue;
          }
          if (budgetUnits.lt(minSize)) {
            diag.budgetTooSmall += 1;
            continue;
          }
          const slippagePct = depth.avgPrice.minus(new Decimal(ask)).div(new Decimal(ask));
          if (slippagePct.gt(maxSlippagePct)) {
            diag.slippageTooHigh += 1;
            continue;
          }
          const premiumUsd = depth.avgPrice.mul(new Decimal(spotPrice)).mul(fillUnits);
          const distancePct = new Decimal(pick.distance).div(strikeTarget);
          const maxDistancePct = new Decimal(0.25);
          ranked.push({
            inst: pick.inst,
            ask,
            bid,
            askSize,
            spread,
            fillUnits,
            premiumUsd,
            distancePct
          });
        }
        if (ranked.length > 0) {
          ranked.sort((a, b) => {
            const premiumDiff = a.premiumUsd.sub(b.premiumUsd).toNumber();
            if (premiumDiff !== 0) return premiumDiff;
            const distanceDiff = a.distancePct.sub(b.distancePct).toNumber();
            if (distanceDiff !== 0) return distanceDiff;
            return a.spread.sub(b.spread).toNumber();
          });
          for (const pick of ranked.slice(0, 3)) {
            optionCandidates.push({
              instrument: pick.inst.instrument_name,
              ask: pick.ask,
              strike: Number(pick.inst.strike),
              expiryTag,
              sizeUnits: pick.fillUnits,
              premiumUsd: pick.premiumUsd,
              distancePct: pick.distancePct,
              spread: pick.spread
            });
          }
        }
      }

      if (!optionCandidates.length) {
        await audit("option_ladder_diag", {
          asset: plan.asset,
          optionType,
          strikeTarget: strikeTarget.toFixed(2),
          hedgeBudgetRemaining,
          recoverableMarginUsdc,
          effectiveBudget,
          maxSpread: maxSpread.toFixed(4),
          targetUnits: targetUnits.toFixed(6),
          diag
        });
      }

      if (optionCandidates.length) {
        optionCandidates.sort((a, b) => {
          const premiumDiff = a.premiumUsd.sub(b.premiumUsd).toNumber();
          if (premiumDiff !== 0) return premiumDiff;
          const distanceDiff = a.distancePct.sub(b.distancePct).toNumber();
          if (distanceDiff !== 0) return distanceDiff;
          return a.spread.sub(b.spread).toNumber();
        });
        const floorPrice =
          optionType === "put"
            ? strikeTarget.toNumber()
            : strikeTarget.toNumber();
        let lastFailure: Record<string, unknown> | null = null;
        for (const candidate of optionCandidates) {
          await audit("hedge_action", {
            action: "net_exposure",
            reason: plan.reason,
            instrument: candidate.instrument,
            size: candidate.sizeUnits.toNumber(),
            notionalUsdc: plan.targetNotional.abs().toNumber(),
            hedgeType: "option",
            hedgeFactor: hedgeFactor.toNumber(),
            fundingRate,
            coverageIds
          });
          const res = await app.inject({
            method: "POST",
            url: "/deribit/order",
            payload: {
              instrument: candidate.instrument,
              amount: candidate.sizeUnits.toNumber(),
              side: "buy",
              type: "market",
              coverageId: body.coverageId || `net-${plan.asset}`,
              notionalUsdc: plan.targetNotional.abs().toNumber(),
              hedgeType: "option",
              feeUsdc: 0,
              tierName,
              premiumUsdc: candidate.premiumUsd.toFixed(2),
              spotPrice,
              floorPrice
            }
          });
          const payload = res.json() as Record<string, unknown>;
          const status = String(payload?.status || "");
          if (status === "paper_filled" || status === "filled" || status === "ok") {
            optionChosen = candidate;
            break;
          }
          const reason = String(payload?.reason || "");
          lastFailure = { instrument: candidate.instrument, status, reason };
          if (status !== "paper_rejected" || (reason !== "no_top_of_book" && reason !== "insufficient_liquidity")) {
            break;
          }
        }
        if (optionChosen) {
          continue;
        }
        if (lastFailure) {
          await audit("option_exec_failed", {
            ...lastFailure,
            optionType,
            coverageIds
          });
        }
      }

      if (optionChosen) {
        await audit("hedge_action", {
          action: "net_exposure",
          reason: plan.reason,
          instrument: optionChosen.instrument,
          size: optionChosen.sizeUnits.toNumber(),
          notionalUsdc: plan.targetNotional.abs().toNumber(),
          hedgeType: "option",
          hedgeFactor: hedgeFactor.toNumber(),
          fundingRate,
          coverageIds
        });
        await app.inject({
          method: "POST",
          url: "/deribit/order",
          payload: {
            instrument: optionChosen.instrument,
            amount: optionChosen.sizeUnits.toNumber(),
            side: "buy",
            type: "market",
            coverageId: body.coverageId || `net-${plan.asset}`,
            notionalUsdc: plan.targetNotional.abs().toNumber(),
            hedgeType: "option",
            feeUsdc: 0,
            tierName,
            premiumUsdc: optionChosen.premiumUsd.toFixed(2),
            spotPrice,
            floorPrice: strikeTarget.toNumber()
          }
        });
        continue;
      }

      const side = plan.targetNotional.gt(0) ? "buy" : "sell";
      const quotes = await pricingEngine.getQuotes({
        instrument,
        type: "perp",
        side,
        minSize: targetUnits
      });
      if (!quotes.length) continue;
      const candidates = buildBestPriceCandidates(quotes, side);
      const routed = executionRouter.route(candidates, targetUnits);
      if (routed.length === 0) continue;
      const routedPlan = routed[0];
      await audit("hedge_action", {
        action: "net_exposure",
        reason: plan.reason,
        instrument,
        size: routedPlan.size.toNumber(),
        notionalUsdc: plan.targetNotional.abs().toNumber(),
        hedgeType: "perp",
        hedgeFactor: hedgeFactor.toNumber(),
        fundingRate,
        coverageIds
      });
      await executionRegistry.placeOrder(routedPlan.venue || "deribit", {
        instrument,
        amount: routedPlan.size.toNumber(),
        side: plan.targetNotional.gt(0) ? "buy" : "sell",
        type: "market"
      });
      await audit("hedge_order", {
        instrument,
        side: plan.targetNotional.gt(0) ? "buy" : "sell",
        amount: routedPlan.size.toNumber(),
        type: "market",
        notionalUsdc: plan.targetNotional.abs().toNumber(),
        hedgeType: "perp",
        hedgeFactor: hedgeFactor.toNumber(),
        fundingRate,
        coverageIds,
        venue: routedPlan.venue
      });
    }
  }

  if (body.alertWebhookUrl) {
    await sendWebhookAlert(body.alertWebhookUrl, {
      type: "hedge_adjusted",
      message: `Hedge action: ${decision.hedgeAction}, renew: ${decision.renew}`,
      accountId: body.accountId,
      timestamp: new Date().toISOString()
    });
  }

  const response = {
    decision,
    renewalResult
  };
  await audit("loop_tick", { accountId: body.accountId, decision });
  return response;
});

app.post("/audit/export", async (req) => {
  const body = req.body as Record<string, unknown>;
  const coverageId = String(body.coverageId || "");
  const expiryIso = String(body.expiryIso || "");
  if (coverageId && expiryIso) {
    const recent = await readAuditEntries(200);
    const duplicate = recent
      .slice()
      .reverse()
      .find(
        (entry) =>
          entry.event === "coverage_activated" &&
          entry.payload &&
          (entry.payload as any).coverageId === coverageId
      );
    if (duplicate) {
      const expiryMs = Date.parse(expiryIso);
      if (Number.isFinite(expiryMs) && expiryMs > Date.now()) {
        await audit("coverage_duplicate", { coverageId, expiryIso });
        return { status: "duplicate", coverageId };
      }
    }
  }
  const name = `audit-${Date.now()}.json`;
  const path = new URL(`../../../logs/${name}`, import.meta.url);
  await writeFile(path, JSON.stringify(body, null, 2), "utf-8");
  const feeUsd = Number((body as any).totalFeeUsd ?? (body as any).feeUsd ?? 0);
  const tierName = String((body as any).tier || "Unknown");
  const coverageIdValue = String((body as any).coverageId || "");
  const expiryValue = String((body as any).expiryIso || "");
  const positions = Array.isArray((body as any).portfolio?.positions)
    ? ((body as any).portfolio.positions as CoveragePosition[])
    : [];
  if (coverageIdValue && expiryValue && positions.length > 0) {
    activeCoverages.set(coverageIdValue, {
      coverageId: coverageIdValue,
      expiryIso: expiryValue,
      positions
    });
  }
  if (feeUsd > 0) {
    const accounting = recordRevenue(tierName, feeUsd);
    await audit("liquidity_update", {
      coverageId: coverageId || null,
      tier: tierName,
      feeUsdc: feeUsd,
      premiumUsdc: 0,
      notionalUsdc: Number((body as any).notionalUsdc ?? 0),
      delta: accounting.liquidityDelta,
      totals: liquiditySummary()
    });
  }
  await audit("coverage_activated", body);
  return { status: "ok", file: name };
});

app.post("/admin/reset", async () => {
  const cleared = await clearAuditLogs();
  activeCoverages.clear();
  portfolioSnapshots.clear();
  resetRiskState();
  return {
    status: "ok",
    clearedFiles: cleared.cleared
  };
});

app.get("/audit/entries", async (req) => {
  const query = req.query as { limit?: string };
  const limit = Number(query.limit || "200");
  return readAuditEntries(limit);
});

app.get("/audit/summary", async (req) => {
  const query = req.query as { mode?: "exec" | "internal" };
  const mode = query.mode || "exec";
  const entries = await readAuditEntries(500);
  const byEvent = entries.reduce<Record<string, number>>((acc, item) => {
    const event = String(item.event || "unknown");
    acc[event] = (acc[event] || 0) + 1;
    return acc;
  }, {});
  const last = (event: string) =>
    entries.slice().reverse().find((item) => item.event === event) || null;

  const summary = {
    totals: byEvent,
    lastCoverage: last("coverage_activated"),
    lastRenewal: last("coverage_renewed"),
    lastHedgeAction: last("hedge_action"),
    lastMtmCredit: last("mtm_credit")
  };

  if (mode === "exec") {
    return summary;
  }

  const hedgeMetrics = await computeUnrealizedHedgeMetrics();
  const hedgeMtmUsdc = lastMtmSnapshot?.hedgeMtmUsdc ?? new Decimal(0);
  const cashProfitUsdc = liquiditySummary().profitUsdc ?? 0;
  const grossRevenueUsdc = liquiditySummary().revenueUsdc ?? 0;
  const grossHedgeSpendUsdc = liquiditySummary().hedgeSpendUsdc ?? 0;
  const grossSubsidyUsdc = subsidySummary().totalUsdc ?? 0;
  const grossProfitUsdc = new Decimal(grossRevenueUsdc)
    .minus(new Decimal(grossHedgeSpendUsdc))
    .minus(new Decimal(grossSubsidyUsdc));
  const grossMarginPct =
    grossRevenueUsdc > 0 ? grossProfitUsdc.div(new Decimal(grossRevenueUsdc)).mul(100) : null;
  const hedgeNotionalUsdc = hedgeMetrics.hedgeNotionalUsdc;
  const hedgeMarginPct =
    hedgeNotionalUsdc.gt(0)
      ? new Decimal(liquiditySummary().hedgeMarginUsdc ?? 0)
          .div(hedgeNotionalUsdc)
          .mul(100)
      : null;
  const netProfitUsdc = new Decimal(cashProfitUsdc)
    .add(realizedHedgePnlUsdc)
    .add(hedgeMtmUsdc);
  const bookedProfitUsdc = new Decimal(cashProfitUsdc).add(realizedHedgePnlUsdc);
  const expectedProfitUsdc = bookedProfitUsdc.add(hedgeMetrics.unrealizedHedgePnlUsdc);

  return {
    ...summary,
    risk: riskSummary(),
    liquidity: liquiditySummary(),
    subsidy: subsidySummary(),
    profitability: {
      grossRevenueUsdc: Number(grossRevenueUsdc),
      grossHedgeSpendUsdc: Number(grossHedgeSpendUsdc),
      grossSubsidyUsdc: Number(grossSubsidyUsdc),
      grossProfitUsdc: grossProfitUsdc.toNumber(),
      grossMarginPct: grossMarginPct ? grossMarginPct.toNumber() : null,
      cashProfitUsdc: Number(cashProfitUsdc),
      hedgeMtmUsdc: hedgeMtmUsdc.toNumber(),
      realizedHedgePnlUsdc: realizedHedgePnlUsdc.toNumber(),
      unrealizedHedgePnlUsdc: hedgeMetrics.unrealizedHedgePnlUsdc.toNumber(),
      hedgeNotionalUsdc: hedgeNotionalUsdc.toNumber(),
      hedgeMarginPct: hedgeMarginPct ? hedgeMarginPct.toNumber() : null,
      bookedProfitUsdc: bookedProfitUsdc.toNumber(),
      expectedProfitUsdc: expectedProfitUsdc.toNumber(),
      netProfitUsdc: netProfitUsdc.toNumber()
    }
  };
});

app.post("/hedge/roll", async (req) => {
  const body = req.body as {
    bufferPct: number;
    bufferTargetPct: number;
    hysteresisPct: number;
    expiryIso: string;
    renewWindowMinutes: number;
    hedgeInstrument: string;
    hedgeSize: number;
  };

  const bufferPct = new Decimal(body.bufferPct);
  const decision = evaluateRollingHedge({
    bufferPct,
    hedgeState: {
      bufferTargetPct: new Decimal(body.bufferTargetPct),
      hysteresisPct: new Decimal(body.hysteresisPct)
    },
    expiryIso: body.expiryIso,
    renewWindowMinutes: body.renewWindowMinutes
  });

  if (decision.hedgeAction === "increase") {
    await deribit.placeOrder({
      instrument: body.hedgeInstrument,
      amount: body.hedgeSize,
      side: "buy",
      type: "market"
    });
  }

  return {
    decision
  };
});

app.listen({ port: 4100, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

await seedAuditIfEmpty();

// Optional lightweight interval runner (enabled when LOOP_INTERVAL_MS > 0)
if (LOOP_INTERVAL_MS > 0) {
  setInterval(async () => {
    try {
      const config = await loadAccountConfig(configUrl);
      const accounts = config.accounts || [];
      for (const account of accounts) {
        await app.inject({
          method: "POST",
          url: "/loop/tick",
          payload: account
        });
      }
    } catch (err) {
      app.log.error(err);
    }
  }, LOOP_INTERVAL_MS);
}

if (MTM_INTERVAL_MS > 0) {
  setInterval(async () => {
    try {
      const config = await loadAccountConfig(configUrl);
      const accounts = config.accounts || [];
      for (const account of accounts) {
        await app.inject({
          method: "GET",
          url: `/risk/summary?drawdownLimitUsdc=${encodeURIComponent(
            account.drawdownLimitUsdc
          )}&initialBalanceUsdc=${encodeURIComponent(
            account.initialBalanceUsdc
          )}&cashUsdc=${encodeURIComponent(account.initialBalanceUsdc)}`
        });
      }
    } catch (err) {
      app.log.error(err);
    }
  }, MTM_INTERVAL_MS);
}
