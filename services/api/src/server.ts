import Fastify from "fastify";
import cors from "@fastify/cors";
import { appendFile, readdir, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
import { createBybitIvCache } from "./bybitIvCache";
import { createDeribitIvLadderCache } from "./deribitIvLadder";
import { createBybitExecutor, createDeribitExecutor, ExecutionRegistry } from "./executionRegistry";
import {
  getBybitOrderbook,
  getBybitAvailableStrikes,
  formatBybitExpiryTag,
  formatBybitInstrument,
  BybitStrikeSnapshot
} from "./bybitAdapter";
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
  resetRiskState,
  type LiquidityState
} from "./riskControls";
import { sendWebhookAlert } from "@foxify/hedging";

// ═══════════════════════════════════════════════════════════
// CEO-FOCUSED AUDIT EVENTS (Filter for Modal Display)
// ═══════════════════════════════════════════════════════════

const CEO_AUDIT_EVENTS = [
  "coverage_activated",
  "coverage_renewed",
  "coverage_expired",
  "coverage_duplicate",
  "liquidity_update",
  "hedge_order",
  "hedge_action",
  "mtm_position",
  "mtm_credit",
  "demo_credit",
  "put_quote_failed",
  "put_renew_failed",
  "option_exec_failed",
  "close_blocked",
  "put_renew"
];

const EXCLUDED_AUDIT_EVENTS = [
  "portfolio_ingest",
  "mtm_credit",
  "audit_seed",
  "system_startup",
  "iv_ladder_ready",
  "audit_parse_error",
  "put_quote",
  "quote_expired",
  "loop_tick"
];

function isCeoRelevantEvent(eventName: string): boolean {
  return CEO_AUDIT_EVENTS.includes(eventName);
}

const app = Fastify();
await app.register(cors, { origin: true });
const LOOP_INTERVAL_MS = Number(process.env.LOOP_INTERVAL_MS || "600000");
const MTM_INTERVAL_MS = Number(process.env.MTM_INTERVAL_MS || "300000");
const APP_MODE = process.env.APP_MODE || "demo";
const ALLOW_DERIBIT_PRIVATE_MTM =
  process.env.ALLOW_DERIBIT_PRIVATE_MTM === "true" || APP_MODE !== "demo";
const AUDIT_SEED = process.env.AUDIT_SEED !== "false";
const API_PORT = Number(process.env.PORT || process.env.API_PORT || "4100");
const API_HOST = process.env.HOST || "0.0.0.0";
const CONFIG_PATH = process.env.ACCOUNTS_CONFIG_PATH || "../../../configs/live_accounts.json";
const AUDIT_LOG_PATH = new URL("../../../logs/audit.log", import.meta.url);
const LOGS_DIR = new URL("../../../logs/", import.meta.url);
const RISK_CONTROLS_PATH = new URL("../../../configs/risk_controls.json", import.meta.url);
const VENUE_CONFIG_PATH = new URL("../config.json", import.meta.url);
const COVERAGE_FILE_PATH = new URL("../../../logs/coverages.json", import.meta.url);
const HEDGE_LEDGER_PATH = new URL("../../../logs/hedge-ledger.json", import.meta.url);
const COVERAGE_LEDGER_PATH = new URL("../../../logs/coverage-ledger.json", import.meta.url);
const QUOTE_CACHE_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS || "300000");
async function ensureLogsDir(): Promise<void> {
  try {
    await mkdir(LOGS_DIR, { recursive: true });
  } catch (error) {
    console.error("Failed to ensure logs directory:", error);
  }
}
const QUOTE_CACHE_STALE_MS = Number(process.env.QUOTE_CACHE_STALE_MS || "20000");
const QUOTE_CACHE_HARD_MS = Number(process.env.QUOTE_CACHE_HARD_MS || "120000");
const MTM_BUFFER_THRESHOLD_USDC = new Decimal(process.env.MTM_BUFFER_THRESHOLD_USDC || "50");
const MTM_BUFFER_THRESHOLD_PCT = new Decimal(process.env.MTM_BUFFER_THRESHOLD_PCT || "0.005");
const MTM_COVERAGE_RATIO_THRESHOLD = new Decimal(
  process.env.MTM_COVERAGE_RATIO_THRESHOLD || "0.05"
);

type VenueMode = "bybit_only" | "deribit_only" | "dual_venue";
type VenueConfig = {
  mode: VenueMode;
  bybit_enabled: boolean;
  deribit_enabled: boolean;
  dual_venue_enabled: boolean;
};

const DEFAULT_VENUE_CONFIG: VenueConfig = {
  mode: "bybit_only",
  bybit_enabled: true,
  deribit_enabled: false,
  dual_venue_enabled: false
};

function normalizeVenueMode(mode: unknown): VenueMode {
  if (mode === "bybit_only" || mode === "deribit_only" || mode === "dual_venue") return mode;
  return "bybit_only";
}

async function loadVenueConfig(): Promise<VenueConfig> {
  try {
    const raw = await readFile(VENUE_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const fileVenue = parsed?.venue ?? {};
    return {
      ...DEFAULT_VENUE_CONFIG,
      ...fileVenue,
      mode: normalizeVenueMode(fileVenue.mode)
    };
  } catch (error: any) {
    console.warn(
      `[Config] Venue config unavailable, using defaults: ${error?.message ?? "unknown"}`
    );
    return { ...DEFAULT_VENUE_CONFIG };
  }
}

console.log(
  `✓ Hedging loop interval: ${LOOP_INTERVAL_MS}ms (${(LOOP_INTERVAL_MS / 60000).toFixed(1)} minutes)`
);
console.log(
  `✓ MTM update interval: ${MTM_INTERVAL_MS}ms (${(MTM_INTERVAL_MS / 60000).toFixed(1)} minutes)`
);

// Load config at startup (fail fast if invalid)
const configUrl = new URL(CONFIG_PATH, import.meta.url);
await loadAccountConfig(configUrl);
const riskControls = await loadRiskControls(RISK_CONTROLS_PATH);
const venueConfig = await loadVenueConfig();

console.log("════════════════════════════════════════════════════════");
console.log(`[Venue] Mode: ${venueConfig.mode.toUpperCase()}`);
if (venueConfig.mode === "bybit_only") {
  console.log("[Venue] ⚡ BYBIT-ONLY MODE (Demo optimized - 50% faster)");
  console.log("[Venue] Deribit fallback: Available if Bybit fails");
}
console.log("════════════════════════════════════════════════════════");

type QuoteCacheEntry = { ts: number; response: Record<string, unknown> };
const quoteCache = new Map<string, QuoteCacheEntry>();
const quoteInflight = new Map<string, Promise<Record<string, unknown>>>();
type QuoteLock = {
  feeUsdc: Decimal;
  premiumTotalUsdc?: Decimal;
  premiumPerUnitUsdc?: Decimal;
  hedgeSize?: Decimal;
  issuedAt: number;
  expiresAt: number;
  tierName: string;
  instruments: string[];
};
const quoteLocks = new Map<string, QuoteLock>();
const cacheStats = { hits: 0, misses: 0, avgHitTime: 0, avgMissTime: 0 };
const hedgeActionCooldownByCoverage = new Map<string, number>();
const netExposureCooldownByTier = new Map<string, number>();

const extractQuoteInstruments = (response: Record<string, unknown>): string[] => {
  const instruments = new Set<string>();
  const responseAny = response as any;
  const direct = responseAny.instrument ?? responseAny?.hedge?.instrument;
  if (typeof direct === "string" && direct.length > 0) {
    instruments.add(direct);
  }
  const executionPlan = responseAny.executionPlan;
  if (Array.isArray(executionPlan)) {
    for (const plan of executionPlan) {
      const instrument = plan?.instrument;
      if (typeof instrument === "string" && instrument.length > 0) {
        instruments.add(instrument);
      }
    }
  }
  return Array.from(instruments);
};

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
  const spot = Number(body.spotPrice || 0);
  const drawdown = Number(body.drawdownFloorPct || 0);
  const targetDays = Number(body.targetDays || 0);
  const spotBucket = Math.round(spot / 500) * 500;
  const drawdownBucket = Math.round(drawdown / 0.05) * 0.05;
  const daysBucket = Math.round(targetDays);
  return JSON.stringify({
    tierName: body.tierName || "",
    asset: (body.asset || "BTC").toUpperCase(),
    spot: spotBucket.toFixed(2),
    drawdown: drawdownBucket.toFixed(4),
    fixed: Number(body.fixedPriceUsdc || 0).toFixed(2),
    expiryTag: body.expiryTag || "",
    targetDays: daysBucket,
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

function recordCacheHit(elapsedMs: number): void {
  cacheStats.hits += 1;
  cacheStats.avgHitTime =
    (cacheStats.avgHitTime * (cacheStats.hits - 1) + elapsedMs) / cacheStats.hits;
  const total = cacheStats.hits + cacheStats.misses;
  console.log(`[Cache] HIT - Hit rate: ${((cacheStats.hits / total) * 100).toFixed(1)}%`);
}

function recordCacheMiss(elapsedMs: number): void {
  cacheStats.misses += 1;
  cacheStats.avgMissTime =
    (cacheStats.avgMissTime * (cacheStats.misses - 1) + elapsedMs) / cacheStats.misses;
  const total = cacheStats.hits + cacheStats.misses;
  console.log(`[Cache] MISS - Hit rate: ${((cacheStats.hits / total) * 100).toFixed(1)}%`);
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

// ═══════════════════════════════════════════════════════════
// COVERAGE PERSISTENCE
// ═══════════════════════════════════════════════════════════

async function saveCoverages(): Promise<void> {
  try {
    const data = Array.from(activeCoverages.entries());
    await writeFile(COVERAGE_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
    console.log(`✓ Saved ${data.length} coverage(s) to file`);
  } catch (error) {
    console.error("Failed to save coverages:", error);
  }
}

async function loadCoverages(): Promise<void> {
  try {
    const { existsSync } = await import("node:fs");
    if (!existsSync(COVERAGE_FILE_PATH)) {
      console.log("No coverage file found (fresh start)");
      return;
    }
    const raw = await (await import("node:fs/promises")).readFile(
      COVERAGE_FILE_PATH,
      "utf-8"
    );
    const data = JSON.parse(raw) as Array<[string, CoverageRecord]>;
    const now = Date.now();
    let loadedCount = 0;
    let expiredCount = 0;
    for (const [key, value] of data) {
      const expiryMs = Date.parse(value.expiryIso);
      if (Number.isFinite(expiryMs) && expiryMs > now) {
        activeCoverages.set(key, value);
        loadedCount++;
      } else {
        expiredCount++;
      }
    }
    console.log(`✓ Loaded ${loadedCount} active coverage(s), skipped ${expiredCount} expired`);
  } catch (error) {
    console.error("Failed to load coverages:", error);
  }
}

// ═══════════════════════════════════════════════════════════
// COVERAGE LEDGER PERSISTENCE
// ═══════════════════════════════════════════════════════════

function serializeCoverageLedger(): CoverageLedgerEntry[] {
  return Array.from(coverageLedger.values()).map((entry) => ({
    ...entry,
    positions: entry.positions ?? [],
    updatedAt: entry.updatedAt || new Date().toISOString()
  }));
}

async function saveCoverageLedger(): Promise<void> {
  try {
    const data = {
      ledger: serializeCoverageLedger(),
      timestamp: new Date().toISOString()
    };
    await writeFile(COVERAGE_LEDGER_PATH, JSON.stringify(data, null, 2), "utf-8");
    console.log(`✓ Saved coverage ledger (${data.ledger.length} entries)`);
  } catch (error) {
    console.error("Failed to save coverage ledger:", error);
  }
}

async function loadCoverageLedger(): Promise<void> {
  try {
    const { existsSync } = await import("node:fs");
    if (!existsSync(COVERAGE_LEDGER_PATH)) {
      console.log("No coverage ledger found (fresh start)");
      return;
    }
    const raw = await (await import("node:fs/promises")).readFile(COVERAGE_LEDGER_PATH, "utf-8");
    const data = JSON.parse(raw) as {
      ledger?: CoverageLedgerEntry[];
      timestamp?: string;
    };
    const entries = Array.isArray(data.ledger) ? data.ledger : [];
    for (const entry of entries) {
      if (!entry?.coverageId) continue;
      coverageLedger.set(entry.coverageId, {
        ...entry,
        positions: entry.positions ?? [],
        updatedAt: entry.updatedAt || new Date().toISOString()
      });
    }
    console.log(`✓ Loaded coverage ledger: ${coverageLedger.size} entries`);
  } catch (error) {
    console.error("Failed to load coverage ledger:", error);
  }
}

function upsertCoverageLedger(
  update: Partial<CoverageLedgerEntry> & { coverageId: string }
): CoverageLedgerEntry {
  const existing = coverageLedger.get(update.coverageId);
  const now = new Date().toISOString();
  const next: CoverageLedgerEntry = {
    coverageId: update.coverageId,
    expiryIso: update.expiryIso || existing?.expiryIso || "",
    positions: update.positions || existing?.positions || [],
    accountId: update.accountId ?? existing?.accountId ?? null,
    tier: update.tier ?? existing?.tier ?? null,
    autoRenew: update.autoRenew ?? existing?.autoRenew ?? undefined,
    selectedVenue: update.selectedVenue ?? existing?.selectedVenue ?? null,
    hedgeInstrument: update.hedgeInstrument ?? existing?.hedgeInstrument ?? null,
    hedgeSize: update.hedgeSize ?? existing?.hedgeSize ?? null,
    hedgeType: update.hedgeType ?? existing?.hedgeType ?? null,
    optionType: update.optionType ?? existing?.optionType ?? null,
    strike: update.strike ?? existing?.strike ?? null,
    coverageLegs: update.coverageLegs ?? existing?.coverageLegs ?? undefined,
    notionalUsdc: update.notionalUsdc ?? existing?.notionalUsdc ?? null,
    floorUsd: update.floorUsd ?? existing?.floorUsd ?? null,
    equityUsd: update.equityUsd ?? existing?.equityUsd ?? null,
    markSource: update.markSource ?? existing?.markSource ?? null,
    mtmAttribution: update.mtmAttribution ?? existing?.mtmAttribution ?? null,
    lastMtm: update.lastMtm ?? existing?.lastMtm ?? null,
    creditUsdc: update.creditUsdc ?? existing?.creditUsdc ?? undefined,
    expiredAt: update.expiredAt ?? existing?.expiredAt ?? undefined,
    status: update.status ?? existing?.status ?? "active",
    updatedAt: now
  };
  coverageLedger.set(update.coverageId, next);
  return next;
}

// ═══════════════════════════════════════════════════════════
// HEDGE LEDGER PERSISTENCE
// ═══════════════════════════════════════════════════════════

function serializeHedgeLedger(): Array<[string, { size: string; avgCostUsdc: string }]> {
  const entries: Array<[string, { size: string; avgCostUsdc: string }]> = [];
  for (const [instrument, entry] of hedgeLedger.entries()) {
    entries.push([
      instrument,
      {
        size: entry.size.toString(),
        avgCostUsdc: entry.avgCostUsdc.toString()
      }
    ]);
  }
  return entries;
}

async function saveHedgeLedger(): Promise<void> {
  try {
    const data = {
      ledger: serializeHedgeLedger(),
      realizedPnl: realizedHedgePnlUsdc.toString(),
      timestamp: new Date().toISOString()
    };
    await writeFile(HEDGE_LEDGER_PATH, JSON.stringify(data, null, 2), "utf-8");
    console.log(
      `✓ Saved hedge ledger (${data.ledger.length} positions, realizedPnl=$${realizedHedgePnlUsdc.toFixed(
        2
      )})`
    );
  } catch (error) {
    console.error("Failed to save hedge ledger:", error);
  }
}

async function loadHedgeLedger(): Promise<void> {
  try {
    const { existsSync } = await import("node:fs");
    if (!existsSync(HEDGE_LEDGER_PATH)) {
      console.log("No hedge ledger found (fresh start)");
      return;
    }
    const raw = await (await import("node:fs/promises")).readFile(HEDGE_LEDGER_PATH, "utf-8");
    const data = JSON.parse(raw) as {
      ledger: Array<[string, { size: string; avgCostUsdc: string }]>;
      realizedPnl: string;
      timestamp: string;
    };
    for (const [instrument, entry] of data.ledger) {
      hedgeLedger.set(instrument, {
        size: new Decimal(entry.size),
        avgCostUsdc: new Decimal(entry.avgCostUsdc)
      });
    }
    realizedHedgePnlUsdc = new Decimal(data.realizedPnl);
    console.log(
      `✓ Loaded hedge ledger: ${data.ledger.length} positions, realizedPnl=$${realizedHedgePnlUsdc.toFixed(
        2
      )})`
    );
  } catch (error) {
    console.error("Failed to load hedge ledger:", error);
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

type CoverageLedgerEntry = {
  coverageId: string;
  expiryIso: string;
  positions: CoveragePosition[];
  accountId?: string | null;
  tier?: string | null;
  autoRenew?: boolean;
  selectedVenue?: string | null;
  hedgeInstrument?: string | null;
  hedgeSize?: number | null;
  hedgeType?: "option" | "perp" | null;
  optionType?: "put" | "call" | null;
  strike?: number | null;
  coverageLegs?: Array<{
    instrument: string;
    size: number;
    venue?: string | null;
    optionType?: "put" | "call" | null;
    strike?: number | null;
  }>;
  notionalUsdc?: number | null;
  floorUsd?: number | null;
  equityUsd?: number | null;
  markSource?: "bybit" | "deribit" | null;
  mtmAttribution?: "position" | "net" | null;
  lastMtm?: {
    bufferUsdc?: string;
    coverageRatio?: string;
    ts?: string;
  } | null;
  creditUsdc?: number;
  expiredAt?: string;
  status?: "active" | "expired";
  updatedAt: string;
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
const coverageLedger = new Map<string, CoverageLedgerEntry>();
const portfolioSnapshots = new Map<string, { positions: PortfolioExposure[]; updatedAt: string }>();
const hedgeLedger = new Map<string, { size: Decimal; avgCostUsdc: Decimal }>();
let realizedHedgePnlUsdc = new Decimal(0);
let lastMtmSnapshot: { equityUsdc: Decimal; positionPnlUsdc: Decimal; hedgeMtmUsdc: Decimal } | null =
  null;
let lastMtmSnapshotAt = 0;

function parseInstrumentAsset(instrument: string): string | null {
  const parts = instrument.split("-");
  if (parts.length >= 1) return parts[0] || null;
  return null;
}

function inferVenueFromInstrument(instrument?: string | null): "bybit" | "deribit" | null {
  if (!instrument) return null;
  if (instrument.endsWith("-USDT")) return "bybit";
  return "deribit";
}

function parseOptionInstrument(
  instrument?: string | null
): { strike: number | null; optionType: "put" | "call" | null } {
  if (!instrument) return { strike: null, optionType: null };
  const parts = instrument.split("-");
  if (parts.length < 4) return { strike: null, optionType: null };
  const strikeValue = Number(parts[2]);
  const rawType = parts[3]?.toUpperCase();
  const optionType =
    rawType === "P" ? "put" : rawType === "C" ? "call" : null;
  return {
    strike: Number.isFinite(strikeValue) ? strikeValue : null,
    optionType
  };
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
      if (instrument.endsWith("-USDT")) {
        if (instrument.includes("PERPETUAL")) {
          const asset = parseInstrumentAsset(instrument);
          const spot = asset ? await fetchSpotPrice(asset) : null;
          if (spot) {
            markPriceUsdc = spot;
          }
        } else {
          markPriceUsdc = await fetchBybitOptionMarkUsdc(instrument);
        }
      } else {
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
            if (
              Number.isFinite(markBtc) &&
              markBtc > 0 &&
              Number.isFinite(underlying) &&
              underlying > 0
            ) {
              markPriceUsdc = new Decimal(markBtc).mul(new Decimal(underlying));
            } else {
              const asset = parseInstrumentAsset(instrument);
              if (asset) {
                const index = await deribit.getIndexPrice(`${asset.toLowerCase()}_usd`);
                const spot = Number((index as any)?.result?.index_price ?? 0);
                if (
                  Number.isFinite(markBtc) &&
                  markBtc > 0 &&
                  Number.isFinite(spot) &&
                  spot > 0
                ) {
                  markPriceUsdc = new Decimal(markBtc).mul(new Decimal(spot));
                }
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

async function fetchSpotPrice(asset: string): Promise<Decimal | null> {
  try {
    const index = await deribit.getIndexPrice(`${asset.toLowerCase()}_usd`);
    const spot = Number((index as any)?.result?.index_price ?? 0);
    if (!Number.isFinite(spot) || spot <= 0) return null;
    return new Decimal(spot);
  } catch {
    return null;
  }
}

async function fetchDeribitOptionMarkUsdc(
  instrument: string,
  spotPrice: Decimal
): Promise<Decimal | null> {
  try {
    const ticker = await deribit.getTicker(instrument);
    const result = (ticker as any)?.result || {};
    const markUsd = Number(result?.mark_price_usd ?? 0);
    if (Number.isFinite(markUsd) && markUsd > 0) {
      return new Decimal(markUsd);
    }
    const markBtc = Number(result?.mark_price ?? 0);
    if (Number.isFinite(markBtc) && markBtc > 0) {
      return new Decimal(markBtc).mul(spotPrice);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchBybitOptionMarkUsdc(instrument: string): Promise<Decimal | null> {
  try {
    const expiryTag = deriveExpiryTag(instrument);
    const expiryDate = expiryTag ? parseExpiryTagToDate(expiryTag) : null;
    const asset = parseInstrumentAsset(instrument);
    const optionMeta = parseOptionInstrument(instrument);
    if (!expiryDate || !asset || !optionMeta.optionType || !optionMeta.strike) return null;
    const optionSymbol = optionMeta.optionType === "put" ? "P" : "C";
    const book = await getBybitOrderbook(asset, optionMeta.strike, expiryDate, optionSymbol);
    if (!book) return null;
    const bid = Number(book.bid || 0);
    const ask = Number(book.ask || 0);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return new Decimal(bid).add(new Decimal(ask)).div(2);
    }
    if (Number.isFinite(ask) && ask > 0) return new Decimal(ask);
    if (Number.isFinite(bid) && bid > 0) return new Decimal(bid);
    return null;
  } catch {
    return null;
  }
}

async function fetchCoverageOptionMarkUsdc(
  venue: string | null,
  instrument: string,
  spotPrice: Decimal
): Promise<Decimal | null> {
  if (venue === "bybit") {
    return fetchBybitOptionMarkUsdc(instrument);
  }
  return fetchDeribitOptionMarkUsdc(instrument, spotPrice);
}

function shouldLogMtmUpdate(params: {
  entry: CoverageLedgerEntry;
  bufferUsdc: Decimal;
  bufferPct: Decimal;
  coverageRatio?: Decimal | null;
  lastBufferPct?: Decimal | null;
}): boolean {
  const lastBuffer = params.entry.lastMtm?.bufferUsdc
    ? new Decimal(params.entry.lastMtm.bufferUsdc)
    : null;
  const lastCoverage = params.entry.lastMtm?.coverageRatio
    ? new Decimal(params.entry.lastMtm.coverageRatio)
    : null;
  if (!lastBuffer) return true;
  const bufferDelta = params.bufferUsdc.minus(lastBuffer).abs();
  if (bufferDelta.greaterThanOrEqualTo(MTM_BUFFER_THRESHOLD_USDC)) return true;
  if (params.lastBufferPct) {
    const pctDelta = params.bufferPct.minus(params.lastBufferPct).abs();
    if (pctDelta.greaterThanOrEqualTo(MTM_BUFFER_THRESHOLD_PCT)) return true;
  }
  if (params.coverageRatio && lastCoverage) {
    const ratioDelta = params.coverageRatio.minus(lastCoverage).abs();
    if (ratioDelta.greaterThanOrEqualTo(MTM_COVERAGE_RATIO_THRESHOLD)) return true;
  }
  if (params.bufferUsdc.isNegative() && lastBuffer.greaterThanOrEqualTo(0)) return true;
  return false;
}

function mergeCoverageLegs(
  existing: CoverageLedgerEntry["coverageLegs"] | undefined,
  leg: {
    instrument: string;
    size: number;
    venue?: string | null;
    optionType?: "put" | "call" | null;
    strike?: number | null;
  }
): CoverageLedgerEntry["coverageLegs"] {
  const legs = Array.isArray(existing) ? existing.slice() : [];
  const idx = legs.findIndex((entry) => entry.instrument === leg.instrument);
  if (idx >= 0) {
    const updated = { ...legs[idx] };
    updated.size = Number(updated.size || 0) + leg.size;
    updated.venue = leg.venue ?? updated.venue;
    updated.optionType = leg.optionType ?? updated.optionType;
    updated.strike = leg.strike ?? updated.strike;
    legs[idx] = updated;
    return legs;
  }
  legs.push({ ...leg });
  return legs;
}

function buildCoverageLegsFromPlans(
  plans: Array<{
    venue: string;
    instrument: string;
    side: "buy" | "sell";
    size: Decimal;
    price: Decimal;
  }>
): CoverageLedgerEntry["coverageLegs"] {
  let legs: CoverageLedgerEntry["coverageLegs"] = [];
  for (const plan of plans) {
    if (!plan.instrument || !plan.size) continue;
    const parsed = parseOptionInstrument(plan.instrument);
    legs = mergeCoverageLegs(legs, {
      instrument: plan.instrument,
      size: Number(plan.size.toFixed(6)),
      venue: plan.venue,
      optionType: parsed.optionType,
      strike: parsed.strike
    });
  }
  return legs;
}

function sumCoverageCredits(): Decimal {
  let total = new Decimal(0);
  for (const entry of coverageLedger.values()) {
    if (entry.creditUsdc && entry.creditUsdc > 0) {
      total = total.add(new Decimal(entry.creditUsdc));
    }
  }
  return total;
}

async function markCoverageExpired(coverageId: string, expiryIso: string): Promise<void> {
  const existing = coverageLedger.get(coverageId);
  if (existing?.status === "expired") return;
  const expiredAt = new Date().toISOString();
  upsertCoverageLedger({
    coverageId,
    expiryIso,
    status: "expired",
    expiredAt
  });
  await saveCoverageLedger();
  await audit("coverage_expired", {
    coverageId,
    expiryIso,
    expiredAt,
    selectedVenue: existing?.selectedVenue ?? null
  });
}

async function computeCoverageMtmSnapshots(): Promise<void> {
  const now = Date.now();
  const spotCache = new Map<string, Decimal>();
  for (const entry of coverageLedger.values()) {
    if (!entry.positions || entry.positions.length === 0) continue;
    const expiryMs = Date.parse(entry.expiryIso);
    if (Number.isFinite(expiryMs) && expiryMs <= now) {
      await markCoverageExpired(entry.coverageId, entry.expiryIso);
      continue;
    }
    const asset = entry.positions[0].asset || "BTC";
    if (!spotCache.has(asset)) {
      const spot = await fetchSpotPrice(asset);
      if (spot) spotCache.set(asset, spot);
    }
    const spotPrice = spotCache.get(asset);
    if (!spotPrice) continue;
    const totalNotional = entry.positions.reduce((acc, pos) => {
      const notional = new Decimal(pos.marginUsd || 0).mul(new Decimal(pos.leverage || 1));
      return acc.add(notional);
    }, new Decimal(0));
    const hedgeSize = Array.isArray(entry.coverageLegs)
      ? new Decimal(
          entry.coverageLegs.reduce((sum, leg) => sum + Number(leg.size || 0), 0)
        )
      : entry.hedgeSize
        ? new Decimal(entry.hedgeSize)
        : new Decimal(0);
    const hedgeVenue =
      entry.markSource ?? entry.selectedVenue ?? inferVenueFromInstrument(entry.hedgeInstrument);
    let hedgeMtmTotal = new Decimal(0);
    if (Array.isArray(entry.coverageLegs) && entry.coverageLegs.length > 0) {
      for (const leg of entry.coverageLegs) {
        if (!leg.instrument || !leg.size) continue;
        const legVenue = leg.venue ?? hedgeVenue;
        const mark = await fetchCoverageOptionMarkUsdc(
          legVenue ?? "deribit",
          leg.instrument,
          spotPrice
        );
        if (mark) {
          hedgeMtmTotal = hedgeMtmTotal.add(mark.mul(new Decimal(leg.size)));
        }
      }
    } else if (
      entry.hedgeType === "option" &&
      entry.hedgeInstrument &&
      hedgeSize.gt(0) &&
      hedgeVenue
    ) {
      const mark = await fetchCoverageOptionMarkUsdc(
        hedgeVenue,
        entry.hedgeInstrument,
        spotPrice
      );
      if (mark) hedgeMtmTotal = mark.mul(hedgeSize);
    }
    const drawdownFloorPct =
      entry.equityUsd && entry.floorUsd && entry.equityUsd > 0
        ? new Decimal(1).minus(new Decimal(entry.floorUsd).div(entry.equityUsd))
        : new Decimal(0.2);
    const optionType = entry.optionType ?? "put";
    const floorPrice = computeFloorPrice(spotPrice, drawdownFloorPct, optionType);
    let coverageCreditTotal = new Decimal(0);
    if (Array.isArray(entry.coverageLegs) && entry.coverageLegs.length > 0) {
      for (const leg of entry.coverageLegs) {
        if (!Number.isFinite(leg.strike) || !leg.size) continue;
        const intrinsic = computeIntrinsicAtFloor({
          spotPrice,
          drawdownFloorPct,
          optionType: leg.optionType ?? optionType,
          strike: new Decimal(leg.strike)
        });
        if (intrinsic.gt(0)) {
          coverageCreditTotal = coverageCreditTotal.add(
            intrinsic.mul(new Decimal(leg.size))
          );
        }
      }
    }
    const survivalTolerance = new Decimal(riskControls.survival_tolerance_pct ?? 0.98);

    for (const position of entry.positions) {
      const margin = new Decimal(position.marginUsd || 0);
      const leverage = new Decimal(position.leverage || 1);
      const entryPrice = new Decimal(position.entryPrice || 0);
      if (margin.lte(0) || leverage.lte(0) || entryPrice.lte(0)) continue;
      const notional = margin.mul(leverage);
      const sizeUnits = notional.div(entryPrice);
      const pnl =
        position.side === "short"
          ? entryPrice.minus(spotPrice).mul(sizeUnits)
          : spotPrice.minus(entryPrice).mul(sizeUnits);
      const hedgeShare = totalNotional.gt(0) ? notional.div(totalNotional) : new Decimal(1);
      const hedgeMtm = hedgeMtmTotal.mul(hedgeShare);
      const existingCreditTotal = new Decimal(entry.creditUsdc ?? 0);
      const creditShare = existingCreditTotal.mul(hedgeShare);
      let equityUsdc = margin.add(pnl).add(hedgeMtm).add(creditShare);
      const drawdownLimitUsdc = margin.mul(new Decimal(1).minus(drawdownFloorPct));
      let bufferUsdc = equityUsdc.minus(drawdownLimitUsdc);
      let bufferPct = margin.gt(0) ? bufferUsdc.div(margin) : new Decimal(0);
      const lastBuffer = entry.lastMtm?.bufferUsdc
        ? new Decimal(entry.lastMtm.bufferUsdc)
        : null;
      const lastBufferPct =
        entry.lastMtm?.bufferUsdc && margin.gt(0)
          ? new Decimal(entry.lastMtm.bufferUsdc).div(margin)
          : null;
      const hedgedSize = hedgeSize.mul(hedgeShare);
      const survivalCheck = buildSurvivalCheck({
        spotPrice,
        drawdownFloorPct,
        optionType,
        strike: entry.strike ? new Decimal(entry.strike) : null,
        hedgeSize: hedgedSize,
        requiredSize: sizeUnits,
        tolerancePct: survivalTolerance
      });
      const coverageRatioBase = survivalCheck?.coverageRatio
        ? new Decimal(survivalCheck.coverageRatio)
        : null;
      const requiredCredit = spotPrice.sub(floorPrice).abs().mul(sizeUnits);
      const coverageRatio = coverageCreditTotal.gt(0)
        ? requiredCredit.gt(0)
          ? coverageCreditTotal.mul(hedgeShare).div(requiredCredit)
          : null
        : coverageRatioBase;
      let creditApplied = new Decimal(0);
      if (bufferUsdc.isNegative()) {
        creditApplied = bufferUsdc.abs();
        const nextCreditTotal = existingCreditTotal.add(creditApplied);
        equityUsdc = equityUsdc.add(creditApplied);
        bufferUsdc = bufferUsdc.add(creditApplied);
        bufferPct = margin.gt(0) ? bufferUsdc.div(margin) : new Decimal(0);
        await audit("demo_credit", {
          coverageId: entry.coverageId,
          positionId: position.id,
          creditUsdc: creditApplied.toFixed(2),
          totalCreditUsdc: nextCreditTotal.toFixed(2),
          bufferUsdc: bufferUsdc.sub(creditApplied).toFixed(2),
          equityUsdc: equityUsdc.sub(creditApplied).toFixed(2),
          hedgeInstrument: entry.hedgeInstrument ?? null,
          hedgeVenue,
          mtmAttribution: entry.mtmAttribution ?? "position"
        });
        upsertCoverageLedger({
          coverageId: entry.coverageId,
          creditUsdc: nextCreditTotal.toNumber()
        });
        await saveCoverageLedger();
      }
      const shouldLog = shouldLogMtmUpdate({
        entry,
        bufferUsdc,
        bufferPct,
        coverageRatio,
        lastBufferPct
      });
      if (!shouldLog) continue;
      await audit("mtm_position", {
        coverageId: entry.coverageId,
        positionId: position.id,
        asset: position.asset,
        side: position.side,
        entryPrice: entryPrice.toFixed(2),
        leverage: leverage.toFixed(2),
        marginUsd: margin.toFixed(2),
        spotPrice: spotPrice.toFixed(2),
        positionPnlUsdc: pnl.toFixed(2),
        hedgeMtmUsdc: hedgeMtm.toFixed(2),
        equityUsdc: equityUsdc.toFixed(2),
        drawdownLimitUsdc: drawdownLimitUsdc.toFixed(2),
        drawdownBufferUsdc: bufferUsdc.toFixed(2),
        drawdownBufferPct: bufferPct.mul(100).toFixed(2),
        creditUsdc: creditShare.add(creditApplied).toFixed(2),
        coverageRatio: coverageRatio ? coverageRatio.toFixed(4) : null,
        hedgeInstrument: entry.hedgeInstrument ?? null,
        hedgeVenue,
        hedgeSize: hedgedSize.toFixed(6),
        optionType: entry.optionType ?? null,
        strike: entry.strike ?? null,
        floorPrice: survivalCheck?.floorPrice ?? floorPrice.toFixed(2),
        mtmAttribution: entry.mtmAttribution ?? "position"
      });
      upsertCoverageLedger({
        coverageId: entry.coverageId,
        lastMtm: {
          bufferUsdc: bufferUsdc.toFixed(2),
          coverageRatio: coverageRatio ? coverageRatio.toFixed(4) : undefined,
          ts: new Date().toISOString()
        }
      });
      await saveCoverageLedger();
    }
  }
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
  const floorPrice = computeFloorPrice(
    params.spotPrice,
    params.drawdownFloorPct,
    params.optionType
  );
  const requiredCredit = params.spotPrice.sub(floorPrice).abs().mul(params.requiredSize);
  const intrinsic = computeIntrinsicAtFloor({
    spotPrice: params.spotPrice,
    drawdownFloorPct: params.drawdownFloorPct,
    optionType: params.optionType,
    strike: params.strike
  });
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

function computeFloorPrice(
  spotPrice: Decimal,
  drawdownFloorPct: Decimal,
  optionType: "put" | "call"
): Decimal {
  return optionType === "put"
    ? spotPrice.mul(new Decimal(1).minus(drawdownFloorPct))
    : spotPrice.mul(new Decimal(1).plus(drawdownFloorPct));
}

function computeIntrinsicAtFloor(params: {
  spotPrice: Decimal;
  drawdownFloorPct: Decimal;
  optionType: "put" | "call";
  strike: Decimal;
}): Decimal {
  const floorPrice = computeFloorPrice(
    params.spotPrice,
    params.drawdownFloorPct,
    params.optionType
  );
  return params.optionType === "put"
    ? Decimal.max(new Decimal(0), params.strike.sub(floorPrice))
    : Decimal.max(new Decimal(0), floorPrice.sub(params.strike));
}

function requiredHedgeSizeForFullCoverage(params: {
  spotPrice: Decimal;
  drawdownFloorPct: Decimal;
  optionType: "put" | "call";
  strike: Decimal;
  requiredSize: Decimal;
}): Decimal | null {
  const floorPrice = computeFloorPrice(
    params.spotPrice,
    params.drawdownFloorPct,
    params.optionType
  );
  const requiredCredit = params.spotPrice.sub(floorPrice).abs().mul(params.requiredSize);
  const intrinsic = computeIntrinsicAtFloor({
    spotPrice: params.spotPrice,
    drawdownFloorPct: params.drawdownFloorPct,
    optionType: params.optionType,
    strike: params.strike
  });
  if (intrinsic.lte(0)) return null;
  return requiredCredit.div(intrinsic);
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

function resolvePassThroughCapMultiplier(leverage?: number, tierName?: string): Decimal | null {
  if (tierName && riskControls.pass_through_cap_by_tier) {
    const tierCaps = riskControls.pass_through_cap_by_tier[tierName];
    if (tierCaps) {
      const selected = findLeverageMultiplier(leverage, tierCaps);
      if (Number.isFinite(selected) && selected && selected > 0) {
        return new Decimal(selected);
      }
    }
  }
  const selected = findLeverageMultiplier(leverage, riskControls.pass_through_cap_by_leverage);
  if (!Number.isFinite(selected) || !selected || selected <= 0) return null;
  return new Decimal(selected);
}

function resolveDynamicCapMultiplier(ivScaled: number, liquidity: LiquidityState): Decimal {
  const enabled = riskControls.dynamic_cap_enabled !== false;
  if (!enabled) return new Decimal(1);
  const ivValue = Number.isFinite(ivScaled) ? ivScaled : 0;
  const baseLiquidity = riskControls.initial_liquidity_usdc ?? 0;
  const liquidityRatio =
    baseLiquidity > 0 ? liquidity.liquidityBalanceUsdc / baseLiquidity : 0;
  const low = riskControls.dynamic_cap_liquidity_ratio_low ?? 1.0;
  const high = riskControls.dynamic_cap_liquidity_ratio_high ?? 1.5;
  const liquidityScore =
    liquidityRatio <= low
      ? 0
      : liquidityRatio >= high
        ? 1
        : (liquidityRatio - low) / (high - low);
  const thresholds = riskControls.fee_iv_regime_thresholds ?? { low: 0.5, high: 0.8 };
  const normalUplift = riskControls.dynamic_cap_iv_uplift_pct_normal ?? 0.1;
  const highUplift = riskControls.dynamic_cap_iv_uplift_pct_high ?? 0.25;
  const maxUplift = riskControls.dynamic_cap_max_uplift_pct ?? 0.25;
  let ivBoost = 0;
  if (ivValue >= thresholds.high) {
    ivBoost = highUplift;
  } else if (ivValue >= thresholds.low) {
    ivBoost = normalUplift;
  }
  const uplift = Math.min(maxUplift, ivBoost * liquidityScore);
  return new Decimal(1).add(new Decimal(uplift));
}

function applyPassThroughCap(
  baseFee: Decimal,
  allInPremium: Decimal,
  leverage?: number,
  tierName?: string,
  ivScaled = 0,
  liquidity = liquiditySummary()
): {
  maxFee: Decimal | null;
  capped: boolean;
  capMultiplier: Decimal | null;
  dynamicMultiplier: Decimal;
  tierName?: string;
} {
  const capMultiplier = resolvePassThroughCapMultiplier(leverage, tierName);
  if (!capMultiplier) {
    return {
      maxFee: null,
      capped: false,
      capMultiplier: null,
      dynamicMultiplier: new Decimal(1),
      tierName
    };
  }
  const dynamicMultiplier = resolveDynamicCapMultiplier(ivScaled, liquidity);
  const maxFee = baseFee.mul(capMultiplier).mul(dynamicMultiplier);
  const capped = allInPremium.gt(maxFee);
  return { maxFee, capped, capMultiplier, dynamicMultiplier, tierName };
}

function formatCapMultiplier(
  info: {
    capMultiplier: Decimal | null;
    dynamicMultiplier: Decimal;
  },
  digits = 4
): string | null {
  if (!info.capMultiplier) return null;
  return info.capMultiplier.mul(info.dynamicMultiplier).toFixed(digits);
}

function resolvePremiumMarkupPct(tierName: string, leverage?: number): Decimal {
  if (tierName === "Pro (Bronze)") {
    return new Decimal(0);
  }
  const tierMarkup = riskControls.premium_markup_pct_by_tier?.[tierName] ?? 0;
  const leverageMarkup = findLeverageMultiplier(leverage, riskControls.leverage_markup_pct_by_x);
  const leveragePct = Number.isFinite(leverageMarkup) ? leverageMarkup : 0;
  return new Decimal(tierMarkup).add(new Decimal(leveragePct));
}

function resolveDriftTolerance(tierName: string): { pct: Decimal; usdc: Decimal } {
  const pct = riskControls.drift_tolerance_pct_by_tier?.[tierName] ?? 0;
  const usdc = riskControls.drift_tolerance_usdc_by_tier?.[tierName] ?? 0;
  return { pct: new Decimal(pct), usdc: new Decimal(usdc) };
}

function applyBronzeFixedFee(
  tierName: string,
  leverage: number,
  feeUsdc: Decimal,
  optionType?: "put" | "call"
): { fee: Decimal; applied: boolean } {
  if (tierName !== "Pro (Bronze)") {
    return { fee: feeUsdc, applied: false };
  }
  return { fee: feeUsdc, applied: true };
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
    const ladder = ivLadderPut.getSnapshot();
    if (ladder) {
      return normalizeIvValue(ladder.hedgeIv);
    }
  }
  const fallback =
    venueConfig.mode === "bybit_only" ? await bybitIvCache.getAtmIv(asset) : await ivCache.getAtmIv(asset);
  return normalizeIvValue(Number(fallback.toFixed(6)));
}

async function calculateFeeBase(params: {
  tierName: string;
  baseFeeUsdc: Decimal;
  targetDays: number;
  leverage: number;
  asset: string;
  ivCandidate?: number;
  optionType?: "put" | "call";
}): Promise<{
  feeUsdc: Decimal;
  feeRegime: { regime: "low" | "normal" | "high" | null; multiplier: Decimal | null };
  feeLeverage: { multiplier: Decimal | null };
  feeIv: NormalizedIv;
}> {
  const feeIv = await resolveFeeIv(params.asset, params.ivCandidate);
  if (params.tierName === "Pro (Bronze)") {
    const fixedFee = applyMinFee(params.tierName, params.baseFeeUsdc);
    return {
      feeUsdc: fixedFee,
      feeRegime: { regime: null, multiplier: null },
      feeLeverage: { multiplier: new Decimal(1) },
      feeIv
    };
  }
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
  const bronzeFixed = applyBronzeFixedFee(
    params.tierName,
    params.leverage,
    feeUsdc,
    params.optionType
  );
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
  optionType: "put" | "call";
}): { feeUsdc: Decimal | null; baseIv: number | null; hedgeIv: number | null } {
  if (!(riskControls.ctc_enabled ?? false)) return { feeUsdc: null, baseIv: null, hedgeIv: null };
  const ladder =
    params.optionType === "put" ? ivLadderPut.getSnapshot() : ivLadderCall.getSnapshot();
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
  const floorPrice =
    params.optionType === "put"
      ? params.spotPrice.mul(new Decimal(1).minus(params.drawdownPct))
      : params.spotPrice.mul(new Decimal(1).plus(params.drawdownPct));
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
    const intrinsic =
      params.optionType === "put" ? strike.minus(floorPrice) : floorPrice.minus(strike);
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

// GET endpoint to retrieve stored positions
app.get("/portfolio/positions", async (req, reply) => {
  const query = req.query as { accountId?: string };
  const accountId = query.accountId || "demo";

  const snapshot = portfolioSnapshots.get(accountId);

  if (!snapshot) {
    return reply.send({
      status: "ok",
      accountId,
      positions: [],
      message: "No positions found",
      updatedAt: new Date().toISOString()
    });
  }

  return reply.send({
    status: "ok",
    accountId,
    positions: snapshot.positions,
    updatedAt: snapshot.updatedAt,
    count: snapshot.positions.length
  });
});

app.get("/coverage/active", async (req) => {
  const query = req.query as { accountId?: string };
  const accountId = query.accountId || "demo";

  const now = Date.now();
  const active: CoverageRecord[] = [];

  for (const [key, coverage] of activeCoverages.entries()) {
    const expiryMs = Date.parse(coverage.expiryIso);
    if (Number.isFinite(expiryMs) && expiryMs > now) {
      active.push(coverage);
    } else {
      activeCoverages.delete(key);
      if (Number.isFinite(expiryMs)) {
        await markCoverageExpired(key, coverage.expiryIso);
      }
    }
  }

  if (active.length !== activeCoverages.size) {
    await saveCoverages();
  }

  return {
    status: "ok",
    accountId,
    coverages: active,
    count: active.length
  };
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
    approved: riskControls.enable_premium_pass_through !== false,
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
  if (ALLOW_DERIBIT_PRIVATE_MTM && (needsPositionPnl || needsHedgeMtm)) {
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

  const creditUsdc = sumCoverageCredits();
  const summary = computeRiskSummary(
    {
      cashUsdc: new Decimal(query.cashUsdc || "10000").add(creditUsdc),
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
    drawdownBufferPct: summary.drawdownBufferPct.mul(100).toFixed(2),
    creditUsdc: creditUsdc.toFixed(2)
  };
  lastMtmSnapshot = {
    equityUsdc: summary.equityUsdc,
    positionPnlUsdc: positionPnl,
    hedgeMtmUsdc: hedgeMtm
  };
  lastMtmSnapshotAt = Date.now();
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

const deribitEnv = (process.env.DERIBIT_ENV as "testnet" | "live") || "live";
console.log("[Deribit] Using MAINNET endpoint");
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
executionRegistry.register(createBybitExecutor());
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
const bybitIvCache = createBybitIvCache({ ttlMs: 15000, fallbackIv: 0.5 });
const ivLadderPut = createDeribitIvLadderCache(deribit, {
  asset: "BTC",
  optionType: "put",
  expiriesDays: [1, 2, 3, 5, 7],
  floorPcts: [0.12, 0.16, 0.2],
  refreshMs: 300000,
  maxAgeMs: 5000,
  maxSnapshotAgeMs: riskControls.ctc_max_snapshot_age_ms ?? 10000,
  priceBufferPct: riskControls.ctc_price_buffer_pct ?? 0.02
});
const ivLadderCall = createDeribitIvLadderCache(deribit, {
  asset: "BTC",
  optionType: "call",
  expiriesDays: [1, 2, 3, 5, 7],
  floorPcts: [0.12, 0.16, 0.2],
  refreshMs: 300000,
  maxAgeMs: 5000,
  maxSnapshotAgeMs: riskControls.ctc_max_snapshot_age_ms ?? 10000,
  priceBufferPct: riskControls.ctc_price_buffer_pct ?? 0.02
});
ivLadderPut.start();
ivLadderCall.start();
const ladderWarmup = setInterval(() => {
  const putSnapshot = ivLadderPut.getSnapshot();
  const callSnapshot = ivLadderCall.getSnapshot();
  if (putSnapshot) {
    console.log(
      `[iv] ladder_put_ready base=${putSnapshot.baseIv.toFixed(4)} hedge=${putSnapshot.hedgeIv.toFixed(4)}`
    );
  }
  if (callSnapshot) {
    console.log(
      `[iv] ladder_call_ready base=${callSnapshot.baseIv.toFixed(4)} hedge=${callSnapshot.hedgeIv.toFixed(4)}`
    );
  }
  if (putSnapshot && callSnapshot) {
    clearInterval(ladderWarmup);
  }
}, 1000);
setTimeout(() => clearInterval(ladderWarmup), 15000);
const predictionEngine = new VolatilityPredictionEngine(async (asset) => {
  if (!asset || asset.length === 0) return new Decimal(0.5);
  if (asset !== "BTC" && asset !== "ETH") return new Decimal(0.5);
  if (venueConfig.mode === "bybit_only") {
    return bybitIvCache.getAtmIv(asset);
  }
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
  const buildBybitStrikeUniverse = (spot: Decimal): number[] => {
    const increment = 1000;
    const minStrike = Math.floor(spot.mul(0.5).toNumber() / increment) * increment;
    const maxStrike = Math.ceil(spot.mul(1.3).toNumber() / increment) * increment;
    const strikes: number[] = [];
    for (let strike = minStrike; strike <= maxStrike; strike += increment) {
      strikes.push(strike);
    }
    return strikes;
  };

  const rankStrikes = (
    targetStrike: Decimal,
    strikes: number[],
    bufferPct = 0.02
  ): number[] => {
    const target = targetStrike.toNumber();
    const buffer = target * bufferPct;
    const minAcceptable = target - buffer;
    const maxAcceptable = target + buffer;
    const filtered = strikes.filter((strike) => {
      if (optionType === "put") return strike >= minAcceptable;
      return strike <= maxAcceptable;
    });
    const candidates = filtered.length ? filtered : strikes;
    const penalty = target * 10;
    return candidates.sort((a, b) => {
      const scoreA =
        optionType === "put"
          ? (a >= target ? a - target : target - a + penalty)
          : (a <= target ? target - a : a - target + penalty);
      const scoreB =
        optionType === "put"
          ? (b >= target ? b - target : target - b + penalty)
          : (b <= target ? target - b : b - target + penalty);
      return scoreA - scoreB;
    });
  };

  const floorStrike =
    optionType === "put"
      ? spotPrice.mul(new Decimal(1).minus(drawdownFloorPct))
      : spotPrice.mul(new Decimal(1).plus(drawdownFloorPct));
  if (venueConfig.mode === "bybit_only") {
    const asset =
      instruments[0]?.base_currency ||
      instruments[0]?.instrument_name?.split("-")?.[0] ||
      "BTC";
    const strikes = buildBybitStrikeUniverse(spotPrice);
    const ranked = rankStrikes(floorStrike, strikes);
    return ranked.slice(0, maxCount).map((strike) => ({
      strike,
      option_type: optionType,
      instrument_name: buildInstrumentName(
        asset,
        expiryTag,
        String(strike),
        optionType === "put" ? "P" : "C"
      )
    }));
  }

  const scoped = instruments.filter(
    (inst) => inst.option_type === optionType && inst.instrument_name?.includes(expiryTag)
  );
  const ranked = rankStrikes(
    floorStrike,
    scoped.map((inst) => Number(inst.strike || 0))
  );
  const byStrike = new Map<number, any>();
  for (const inst of scoped) {
    const strike = Number(inst.strike || 0);
    if (!byStrike.has(strike)) byStrike.set(strike, inst);
  }
  return ranked
    .map((strike) => byStrike.get(strike))
    .filter(Boolean)
    .slice(0, maxCount);
}

function rankAvailableStrikes(
  targetStrike: Decimal,
  optionType: "put" | "call",
  available: BybitStrikeSnapshot[],
  bufferPct = 0.02
): BybitStrikeSnapshot[] {
  const target = targetStrike.toNumber();
  const buffer = target * bufferPct;
  const minAcceptable = target - buffer;
  const maxAcceptable = target + buffer;
  const filtered = available.filter((entry) => {
    if (optionType === "put") return entry.strike >= minAcceptable;
    return entry.strike <= maxAcceptable;
  });
  const candidates = filtered.length ? filtered : available;
  const penalty = target * 10;
  return candidates
    .slice()
    .sort((a, b) => {
      const scoreA =
        optionType === "put"
          ? (a.strike >= target ? a.strike - target : target - a.strike + penalty)
          : (a.strike <= target ? target - a.strike : a.strike - target + penalty);
      const scoreB =
        optionType === "put"
          ? (b.strike >= target ? b.strike - target : target - b.strike + penalty)
          : (b.strike <= target ? target - b.strike : b.strike - target + penalty);
      return scoreA - scoreB;
    });
}

async function selectBybitStrikeCandidates(
  asset: string,
  expiryTag: string,
  optionType: "put" | "call",
  targetStrike: Decimal,
  maxCount: number
): Promise<Array<any>> {
  const expiryDate = parseExpiryTagToDate(expiryTag);
  if (!expiryDate) return [];
  const optionSymbol = optionType === "put" ? "P" : "C";
  const available = await getBybitAvailableStrikes(asset, expiryDate, optionSymbol);
  if (!available.length) return [];
  const ranked = rankAvailableStrikes(targetStrike, optionType, available);
  const selected = ranked.slice(0, Math.max(1, Math.min(maxCount, 3)));
  const top = selected[0];
  if (top) {
    const delta = top.strike - targetStrike.toNumber();
    const pct = targetStrike.gt(0) ? (delta / targetStrike.toNumber()) * 100 : 0;
    console.log(
      `[Strike Selection] target=${targetStrike.toFixed(2)} selected=${top.strike.toFixed(
        0
      )} delta=${delta.toFixed(2)} pct=${pct.toFixed(2)} available=${available.length}`
    );
  }
  return selected.map((entry) => ({
    strike: entry.strike,
    option_type: optionType,
    instrument_name: entry.symbol.replace(/-USDT$/, "")
  }));
}

function getNextFridayUtc(fromDate: Date): Date {
  const date = new Date(fromDate);
  const dayOfWeek = date.getUTCDay();
  let daysToAdd: number;
  if (dayOfWeek <= 5) {
    daysToAdd = 5 - dayOfWeek;
  } else {
    daysToAdd = 5 + (7 - dayOfWeek);
  }
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  date.setUTCHours(8, 0, 0, 0);
  return date;
}

function buildBybitExpirySearchOrder(
  targetDays: number,
  maxOptions = 3
): Array<{ expiryTag: string; targetDays: number }> {
  const now = new Date();
  const minExpiry = new Date(now);
  minExpiry.setUTCDate(minExpiry.getUTCDate() + Math.max(1, Math.round(targetDays)));
  minExpiry.setUTCHours(8, 0, 0, 0);

  let candidate = getNextFridayUtc(minExpiry);
  if (candidate < minExpiry) {
    candidate = new Date(candidate);
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }

  const order: Array<{ expiryTag: string; targetDays: number }> = [];
  for (let i = 0; i < maxOptions; i += 1) {
    const days = Math.max(
      1,
      Math.ceil((candidate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    );
    order.push({ expiryTag: formatBybitExpiryTag(candidate), targetDays: days });
    candidate = new Date(candidate);
    candidate.setUTCDate(candidate.getUTCDate() + 7);
  }
  return order;
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
  const parts = instrument.split("-");
  const asset = parts[0];
  const expiryTag = parts[1];
  const strike = Number(parts[2]);
  const optionSymbol = parts[3]?.toUpperCase() as "C" | "P" | undefined;
  const expiryDate = expiryTag ? parseExpiryTagToDate(expiryTag) : null;

  const bybitSupported =
    asset && expiryDate && Number.isFinite(strike) && (optionSymbol === "C" || optionSymbol === "P");
  const bybitAllowed = venueConfig.bybit_enabled && bybitSupported;
  const deribitAllowed = venueConfig.deribit_enabled;

  const addBybitQuote = (bybit: any, instrumentName = instrument) => {
    const bidUsd = new Decimal(bybit.bid);
    const askUsd = new Decimal(bybit.ask);
    quotes.push({
      venue: "bybit",
      instrument: instrumentName,
      type: "option",
      book: {
        bid: bidUsd,
        ask: askUsd,
        bidSize: new Decimal(bybit.bidSize || 0),
        askSize: new Decimal(bybit.askSize || 0),
        spreadPct: spreadPct(bybit.bid, bybit.ask),
        timestampMs: bybit.timestamp ?? null,
        markPriceUsd: null
      }
    });
  };

  const addDeribitQuote = (orderBook: any) => {
    const { bid, ask } = bestBidAsk(orderBook);
    const markPrice = orderBook.mark_price ?? null;
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
        bidSize: new Decimal(orderBook.bids?.[0]?.[1] || 0),
        askSize: new Decimal(orderBook.asks?.[0]?.[1] || 0),
        spreadPct: spreadPct(bid || 0, ask || 0),
        timestampMs: orderBook.timestamp ?? null,
        markPriceUsd: markUsd
      }
    });
  };

  if (venueConfig.mode === "bybit_only") {
    console.log("[Venue] Querying Bybit only (demo mode)");
    if (bybitAllowed) {
      try {
        const bybit = await getBybitOrderbook(asset, strike, expiryDate!, optionSymbol!);
        if (bybit?.ask) {
          addBybitQuote(bybit, instrument);
          return quotes;
        }
      } catch (error: any) {
        console.log(`[Venue] Bybit failed, falling back to Deribit: ${error?.message ?? "unknown"}`);
      }
    }

    if (deribitAllowed) {
      try {
        const deribitOrderBook = (await deribit.getOrderBook(instrument) as any)?.result;
        if (deribitOrderBook) {
          addDeribitQuote(deribitOrderBook);
          return quotes;
        }
      } catch (error: any) {
        console.log(`[Venue] Deribit fallback failed: ${error?.message ?? "unknown"}`);
      }
    }

    throw new Error("Bybit and Deribit unavailable");
  }

  if (venueConfig.mode === "deribit_only") {
    console.log("[Venue] Querying Deribit only");
    if (!deribitAllowed) {
      throw new Error("Deribit disabled in config");
    }
    const deribitOrderBook = (await deribit.getOrderBook(instrument) as any)?.result;
    if (deribitOrderBook) {
      addDeribitQuote(deribitOrderBook);
      return quotes;
    }
    throw new Error("Deribit unavailable");
  }

  if (venueConfig.mode === "dual_venue") {
    if (!bybitAllowed && !deribitAllowed) {
      throw new Error("Both venues disabled in config");
    }
    const deribitPromise = deribitAllowed ? deribit.getOrderBook(instrument) : Promise.resolve(null);
    const bybitPromise = bybitAllowed
      ? getBybitOrderbook(asset, strike, expiryDate!, optionSymbol!)
      : Promise.resolve(null);

    const hybridStart = Date.now();
    if (bybitAllowed && deribitAllowed) {
      const raceResult = await Promise.race([
        bybitPromise
          .then((data) => ({ venue: "bybit" as const, data }))
          .catch((error) => ({ venue: "bybit" as const, error })),
        deribitPromise
          .then((data) => ({ venue: "deribit" as const, data }))
          .catch((error) => ({ venue: "deribit" as const, error }))
      ]);
      const raceTime = Date.now() - hybridStart;
      console.log(`[Hybrid] ${raceResult.venue} responded first in ${raceTime}ms`);

      if (raceResult.venue === "bybit" && raceResult.data) {
        console.log("[Hybrid] Fast path: returning Bybit price immediately");
        const bybit = raceResult.data as any;
        addBybitQuote(bybit, instrument);

        Promise.resolve()
          .then(async () => {
            try {
              const deribitOrderBook = (await deribitPromise as any)?.result;
              if (!deribitOrderBook) return;
              const { bid, ask } = bestBidAsk(deribitOrderBook);
              if (!ask) return;
              const deribitAskUsd = new Decimal(ask).mul(spotPrice).toNumber();
              const savings = deribitAskUsd - bybit.ask;
              await audit("hybrid_comparison", {
                bybitPrice: bybit.ask,
                deribitPrice: deribitAskUsd,
                savings: savings.toFixed(2),
                bybitTimeMs: raceTime,
                deribitTimeMs: Date.now() - hybridStart,
                fastPathUsed: true,
                instrument
              });
              if (savings < -5) {
                console.warn(
                  `[Hybrid] ALERT: Deribit was $${Math.abs(savings).toFixed(2)} cheaper`
                );
              }
            } catch (error: any) {
              console.log(`[Hybrid] Background Deribit query failed: ${error?.message ?? "unknown"}`);
            }
          })
          .catch(() => undefined);

        return quotes;
      }
    }

    const [deribitResult, bybitResult] = await Promise.allSettled([
      deribitPromise,
      bybitPromise
    ]);

    const deribitOrderBook =
      deribitResult.status === "fulfilled" ? (deribitResult.value as any)?.result : null;
    if (deribitOrderBook) {
      addDeribitQuote(deribitOrderBook);
    }

    if (bybitResult.status === "fulfilled" && bybitResult.value) {
      addBybitQuote(bybitResult.value, instrument);
    }

    return quotes;
  }

  throw new Error(`Unknown venue mode: ${venueConfig.mode}`);
}

async function fetchDeribitQuoteForInstrument(
  instrument: string,
  spotPrice: Decimal
): Promise<
  | {
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
    }
  | null
> {
  try {
    const deribitOrderBook = (await deribit.getOrderBook(instrument) as any)?.result;
    if (!deribitOrderBook) return null;
    const { bid, ask } = bestBidAsk(deribitOrderBook);
    const markPrice = deribitOrderBook.mark_price ?? null;
    const bidUsd = bid ? new Decimal(bid).mul(spotPrice) : null;
    const askUsd = ask ? new Decimal(ask).mul(spotPrice) : null;
    const markUsd = markPrice ? new Decimal(markPrice).mul(spotPrice) : null;
    return {
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
    };
  } catch {
    return null;
  }
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
    quoteId?: string;
    drawdownLimitUsdc?: string;
    initialBalanceUsdc?: string;
    assets?: string[];
    asset?: string;
    positionPnlUsdc?: string;
    hedgeMtmUsdc?: string;
    floorPrice?: number;
  };
  const slippageTrackingEnabled = riskControls.slippage_tracking_enabled === true;
  const slippageGuardEnabled = riskControls.slippage_guard_enabled === true;
  const slippageSoftPct = new Decimal(riskControls.slippage_soft_pct ?? 0);
  const slippageSoftUsdc = new Decimal(riskControls.slippage_soft_usdc ?? 0);
  const slippageHardPct = new Decimal(riskControls.slippage_hard_pct ?? 0);
  const slippageHardUsdc = new Decimal(riskControls.slippage_hard_usdc ?? 0);
  const slippageRejectHard = riskControls.slippage_reject_hard === true;
  let quoteLock: QuoteLock | null = null;
  if (body.intent !== "close" && body.quoteId && body.feeUsdc !== undefined) {
    const lock = quoteLocks.get(body.quoteId);
    if (!lock) {
      return { status: "rejected", reason: "quote_unknown" };
    }
    if (Date.now() > lock.expiresAt) {
      return { status: "rejected", reason: "quote_expired" };
    }
    const requestedInstrument = String(body.instrument || "");
    const isPerp =
      body.hedgeType === "perp" || requestedInstrument.toUpperCase().includes("PERPETUAL");
    if (!isPerp && lock.instruments.length > 0) {
      const normalized = requestedInstrument.replace(/-USDT$/, "");
      const matches =
        lock.instruments.includes(requestedInstrument) ||
        lock.instruments.includes(normalized) ||
        lock.instruments.includes(`${normalized}-USDT`);
      if (!matches) {
        return {
          status: "rejected",
          reason: "quote_drift",
          drift: "instrument",
          expectedInstruments: lock.instruments
        };
      }
    }
    const requestedFee = new Decimal(body.feeUsdc);
    if (requestedFee.isFinite() && requestedFee.gt(0)) {
      const tolerance = resolveDriftTolerance(lock.tierName);
      const maxFee = lock.feeUsdc.mul(new Decimal(1).add(tolerance.pct)).add(tolerance.usdc);
      if (requestedFee.gt(maxFee)) {
        return {
          status: "rejected",
          reason: "quote_drift",
          maxFeeUsdc: maxFee.toFixed(2),
          quoteFeeUsdc: lock.feeUsdc.toFixed(2)
        };
      }
    }
    quoteLock = lock;
  }
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
  const venue = body.venue || (venueConfig.mode === "bybit_only" ? "bybit" : "deribit");
  const inferredHedgeType =
    body.hedgeType || (body.instrument.includes("PERPETUAL") ? "perp" : "option");
  const instrument =
    venue === "bybit" && typeof body.instrument === "string" && !body.instrument.endsWith("-USDT")
      ? `${body.instrument}-USDT`
      : body.instrument;
  const estimatePremiumEnabled = riskControls.estimate_premium_on_missing === true;
  let quotedPremiumPerUnit: Decimal | null = null;
  let quotedPremiumTotal: Decimal | null = null;
  if (quoteLock?.premiumPerUnitUsdc) {
    quotedPremiumPerUnit = quoteLock.premiumPerUnitUsdc;
  }
  if (quoteLock?.premiumTotalUsdc) {
    quotedPremiumTotal = quoteLock.premiumTotalUsdc;
  }
  if (!quotedPremiumPerUnit && body.premiumUsdc && body.amount) {
    const premiumRaw = new Decimal(body.premiumUsdc);
    const amountRaw = new Decimal(body.amount);
    if (premiumRaw.isFinite() && premiumRaw.gt(0) && amountRaw.gt(0)) {
      quotedPremiumPerUnit = premiumRaw.div(amountRaw);
      quotedPremiumTotal = premiumRaw;
    }
  }
  let slippageEval: {
    status: "ok" | "soft" | "hard" | "skip";
    reason: string;
    quotedPerUnit: string | null;
    currentPerUnit: string | null;
    slippageUsdc: string | null;
    slippagePct: string | null;
  } | null = null;
  let slippageCurrentPerUnit: Decimal | null = null;
  if (
    (slippageTrackingEnabled || slippageGuardEnabled) &&
    inferredHedgeType === "option" &&
    quotedPremiumPerUnit
  ) {
    let spotPriceForMark: Decimal | null = null;
    const spotRaw = Number(body.spotPrice ?? 0);
    if (Number.isFinite(spotRaw) && spotRaw > 0) {
      spotPriceForMark = new Decimal(spotRaw);
    } else if (venue !== "bybit") {
      spotPriceForMark = await fetchSpotPrice(parseInstrumentAsset(instrument) || "BTC");
    }
    const currentMark = await fetchCoverageOptionMarkUsdc(
      venue,
      instrument,
      spotPriceForMark || new Decimal(0)
    );
    if (!currentMark || !currentMark.isFinite() || currentMark.lte(0)) {
      slippageEval = {
        status: "skip",
        reason: "market_unavailable",
        quotedPerUnit: quotedPremiumPerUnit.toFixed(6),
        currentPerUnit: null,
        slippageUsdc: null,
        slippagePct: null
      };
    } else {
      const slippageUsdc = currentMark.sub(quotedPremiumPerUnit);
      const slippagePct = quotedPremiumPerUnit.gt(0)
        ? slippageUsdc.div(quotedPremiumPerUnit)
        : new Decimal(0);
      slippageCurrentPerUnit = currentMark;
      const slippagePositive = slippageUsdc.gt(0);
      const softBreached =
        slippagePositive &&
        ((slippageSoftPct.gt(0) && slippagePct.gt(slippageSoftPct)) ||
          (slippageSoftUsdc.gt(0) && slippageUsdc.gt(slippageSoftUsdc)));
      const hardBreached =
        slippagePositive &&
        ((slippageHardPct.gt(0) && slippagePct.gt(slippageHardPct)) ||
          (slippageHardUsdc.gt(0) && slippageUsdc.gt(slippageHardUsdc)));
      slippageEval = {
        status: hardBreached ? "hard" : softBreached ? "soft" : "ok",
        reason: hardBreached ? "hard_threshold" : softBreached ? "soft_threshold" : "ok",
        quotedPerUnit: quotedPremiumPerUnit.toFixed(6),
        currentPerUnit: currentMark.toFixed(6),
        slippageUsdc: slippageUsdc.toFixed(6),
        slippagePct: slippagePct.mul(100).toFixed(4)
      };
      if (slippageGuardEnabled && hardBreached && slippageRejectHard) {
        if (slippageTrackingEnabled) {
          await audit("slippage_guard", {
            status: "rejected",
            reason: slippageEval.reason,
            quoteId: body.quoteId ?? null,
            coverageId: body.coverageId || null,
            instrument,
            quotedPerUnit: slippageEval.quotedPerUnit,
            currentPerUnit: slippageEval.currentPerUnit,
            slippageUsdc: slippageEval.slippageUsdc,
            slippagePct: slippageEval.slippagePct
          });
        }
        return { status: "rejected", reason: "slippage_guard", slippage: slippageEval };
      }
    }
    if (slippageTrackingEnabled && slippageEval) {
      await audit("slippage_guard", {
        status: slippageEval.status,
        reason: slippageEval.reason,
        quoteId: body.quoteId ?? null,
        coverageId: body.coverageId || null,
        instrument,
        quotedPerUnit: slippageEval.quotedPerUnit,
        currentPerUnit: slippageEval.currentPerUnit,
        slippageUsdc: slippageEval.slippageUsdc,
        slippagePct: slippageEval.slippagePct
      });
    }
  }
  const response = await executionRegistry.placeOrder(venue, {
    instrument,
    amount: body.amount,
    side: body.side,
    type: body.type,
    price: body.price,
    spotPrice: body.spotPrice
  });
  const status = String((response as any)?.status || "");
  const filledAmount = Number((response as any)?.filledAmount ?? body.amount);
  const fillPrice =
    (response as any)?.result?.average_price ??
    (response as any)?.result?.price ??
    (response as any)?.fillPrice ??
    null;
  const spotPrice = body.spotPrice ?? null;
  const isBybitExec = venue === "bybit";
  const premiumUsdcFromOrder =
    inferredHedgeType === "option" && fillPrice
      ? isBybitExec
        ? Number(new Decimal(fillPrice).mul(filledAmount))
        : spotPrice
          ? Number(new Decimal(fillPrice).mul(new Decimal(spotPrice)).mul(filledAmount))
          : null
      : null;
  let estimatedPremiumUsdc: number | null = null;
  if (premiumUsdcFromOrder === null && inferredHedgeType === "option" && estimatePremiumEnabled) {
    if (slippageCurrentPerUnit && Number.isFinite(filledAmount)) {
      estimatedPremiumUsdc = slippageCurrentPerUnit.mul(new Decimal(filledAmount)).toNumber();
    } else if (quotedPremiumPerUnit && Number.isFinite(filledAmount)) {
      estimatedPremiumUsdc = quotedPremiumPerUnit.mul(new Decimal(filledAmount)).toNumber();
    } else if (body.premiumUsdc && Number.isFinite(body.premiumUsdc)) {
      estimatedPremiumUsdc = Number(body.premiumUsdc);
    }
  }
  const baseSubsidyUsdc = Number(body.subsidyUsdc ?? 0);
  let slippageUsdc: number | null = null;
  let slippagePct: number | null = null;
  let slippageSubsidyUsdc = 0;
  const executedPremiumResolved =
    premiumUsdcFromOrder !== null ? premiumUsdcFromOrder : estimatedPremiumUsdc;
  if (
    executedPremiumResolved !== null &&
    quotedPremiumTotal &&
    quotedPremiumTotal.gt(0)
  ) {
    const executed = new Decimal(executedPremiumResolved);
    const slippageDelta = executed.sub(quotedPremiumTotal);
    slippageUsdc = slippageDelta.toNumber();
    slippagePct = slippageDelta.div(quotedPremiumTotal).mul(100).toNumber();
    const slippageCap = new Decimal(riskControls.slippage_subsidy_cap_usdc ?? 0);
    if (
      riskControls.slippage_adjust_subsidy_enabled === true &&
      slippageDelta.gt(0)
    ) {
      const allowed = slippageCap.gt(0)
        ? Decimal.min(slippageDelta, slippageCap)
        : slippageDelta;
      slippageSubsidyUsdc = allowed.toNumber();
    }
  }
  const effectiveSubsidyUsdc = baseSubsidyUsdc + slippageSubsidyUsdc;
  const fillPriceUsdc =
    inferredHedgeType === "option"
      ? fillPrice
        ? isBybitExec
          ? new Decimal(fillPrice)
          : spotPrice
            ? new Decimal(fillPrice).mul(new Decimal(spotPrice))
            : null
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
  const optionMeta = parseOptionInstrument(instrument);
  const resolvedOptionType =
    (body as any).optionType ?? optionMeta.optionType ?? null;
  const resolvedStrike = optionMeta.strike ?? null;
  const executed = status === "paper_filled" || status === "filled" || status === "ok";
  if (executed && fillPriceUsdc) {
    const sizeDelta = new Decimal(filledAmount).mul(body.side === "buy" ? 1 : -1);
    updateHedgeLedger({
      instrument: body.instrument,
      sizeDelta,
      fillPriceUsdc
    });
    await saveHedgeLedger();
  }
  if (body.coverageId) {
    const legSize = Number.isFinite(filledAmount) ? filledAmount : body.amount;
    const existing = coverageLedger.get(body.coverageId);
    const coverageLegs =
      inferredHedgeType === "option"
        ? mergeCoverageLegs(existing?.coverageLegs, {
            instrument,
            size: legSize,
            venue,
            optionType: resolvedOptionType,
            strike: resolvedStrike
          })
        : existing?.coverageLegs;
    upsertCoverageLedger({
      coverageId: body.coverageId,
      hedgeInstrument: instrument,
      hedgeSize: legSize,
      hedgeType: inferredHedgeType === "option" ? "option" : "perp",
      optionType: resolvedOptionType,
      strike: resolvedStrike,
      selectedVenue: venue,
      markSource: venue === "bybit" || venue === "deribit" ? venue : null,
      notionalUsdc: body.notionalUsdc ?? null,
      coverageLegs
    });
    await saveCoverageLedger();
  }
  const premiumForAudit = premiumUsdcFromOrder ?? estimatedPremiumUsdc ?? body.premiumUsdc ?? null;
  const cashflowUsdc =
    premiumForAudit !== null && premiumForAudit !== undefined
      ? String(body.side).toLowerCase() === "sell"
        ? -Number(premiumForAudit)
        : Number(premiumForAudit)
      : null;
  await audit("hedge_order", {
    instrument: body.instrument,
    side: body.side,
    amount: filledAmount,
    type: body.type ?? "market",
    coverageId: body.coverageId || null,
    quoteId: body.quoteId ?? null,
    notionalUsdc: body.notionalUsdc ?? null,
    hedgeType: inferredHedgeType,
    status: status || "submitted",
    fillPrice,
    premiumUsdc: premiumUsdcFromOrder ?? body.premiumUsdc ?? null,
    estimatedPremiumUsdc,
    cashflowUsdc,
    feeUsdc: body.feeUsdc ?? null,
    subsidyUsdc: effectiveSubsidyUsdc || null,
    slippageUsdc,
    slippagePct,
    quotedPremiumUsdc: quotedPremiumTotal ? quotedPremiumTotal.toNumber() : null,
    reason: body.reason ?? null,
    accountId: body.accountId ?? null,
    floorPrice: body.floorPrice ?? null,
    hedgeNotionalUsdc,
    hedgeMarginUsdc,
    venue,
    bestBid: (response as any)?.bestBid ?? null,
    bestAsk: (response as any)?.bestAsk ?? null,
    availableSize: (response as any)?.availableSize ?? null
  });
  if (executed && body.tierName && body.feeUsdc !== undefined) {
    const premiumForAccounting =
      inferredHedgeType === "option"
        ? Number(premiumUsdcFromOrder ?? estimatedPremiumUsdc ?? body.premiumUsdc ?? 0)
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
      subsidyUsdc: effectiveSubsidyUsdc,
      notionalUsdc: body.notionalUsdc ?? 0,
      hedgeNotionalUsdc,
      hedgeMarginUsdc,
      delta: accounting.liquidityDelta,
      totals: liquiditySummary()
    });
    if (effectiveSubsidyUsdc > 0) {
      recordSubsidy(body.tierName, body.accountId || null, effectiveSubsidyUsdc);
    }
  }
  return response;
});

app.get("/deribit/positions", async () => {
  if (!ALLOW_DERIBIT_PRIVATE_MTM) {
    return { status: "disabled", reason: "private_mtm_disabled", positions: [] };
  }
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
  const ladder = ivLadderPut.getSnapshot();
  if (ladder) {
    return { asset, iv: Number(ladder.baseIv.toFixed(6)), ivHedge: Number(ladder.hedgeIv.toFixed(6)) };
  }
  const iv =
    venueConfig.mode === "bybit_only" ? await bybitIvCache.getAtmIv(asset) : await ivCache.getAtmIv(asset);
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
    side?: "long" | "short";
    targetDays?: number;
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
  const optionType = body.side === "short" ? "call" : "put";
  if (spotPrice.lte(0) || positionSize.lte(0)) {
    return { status: "no_quote", reason: "invalid_position" };
  }
  const ctcSafety = calculateCtcSafetyFee({
    tierName,
    drawdownPct: drawdownFloorPct,
    spotPrice,
    positionSize,
    leverage: leverageCheck.value,
    optionType
  });
  const targetDays = Math.max(1, Math.round(body.targetDays ?? 7));
  const targetStrike = optionType === "put"
    ? spotPrice.mul(new Decimal(1).minus(drawdownFloorPct))
    : spotPrice.mul(new Decimal(1).plus(drawdownFloorPct));
  const ladder = optionType === "put" ? ivLadderPut.getSnapshot() : ivLadderCall.getSnapshot();
  let bestInstrument: { instrument: string; strike: number; tenorDays: number; markPrice: number | null } | null =
    null;
  const spotNumber = spotPrice.toNumber();
  const targetStrikeNumber = targetStrike.toNumber();
  if (ladder && ladder.legs.length > 0) {
    const candidates = ladder.legs.filter((leg) => {
      const tenorMatch = Math.abs(leg.tenorDays - targetDays) <= 2;
      if (!tenorMatch) return false;
      if (optionType === "put") {
        return leg.strike <= spotNumber;
      }
      return leg.strike >= spotNumber;
    });
    if (candidates.length > 0) {
      bestInstrument = candidates.reduce((best, leg) => {
        const bestDiff = Math.abs(best.strike - targetStrikeNumber);
        const legDiff = Math.abs(leg.strike - targetStrikeNumber);
        return legDiff < bestDiff ? leg : best;
      });
    }
  }

  if (bestInstrument) {
    const strikeValid =
      optionType === "put" ? bestInstrument.strike <= spotNumber : bestInstrument.strike >= spotNumber;
    if (!strikeValid) {
      console.warn(
        `Strike validation failed: ${optionType} strike ${bestInstrument.strike} vs spot ${spotNumber}`
      );
      bestInstrument = null;
    }
  }

  const baseFeeUsdc = applyMinFee(tierName, new Decimal(body.fixedPriceUsdc ?? 0));
  const markupPct = resolvePremiumMarkupPct(tierName, leverageCheck.value);
  const size = positionSize;
  const premiumUsdcDecimal =
    bestInstrument && Number.isFinite(bestInstrument.markPrice || 0)
      ? new Decimal(bestInstrument.markPrice || 0).mul(spotPrice).mul(size)
      : null;
  const passThroughFee = premiumUsdcDecimal
    ? premiumUsdcDecimal.mul(new Decimal(1).add(markupPct))
    : null;
  const feeUsdc = passThroughFee ? Decimal.max(baseFeeUsdc, passThroughFee) : baseFeeUsdc;
  const feeReason = passThroughFee && passThroughFee.gt(baseFeeUsdc) ? "premium_markup" : "base_fee";

  console.log("CTC Quote Debug:", {
    optionType,
    spotPrice: spotNumber,
    targetStrike: targetStrikeNumber,
    ladderReady: ladder ? "yes" : "no",
    ladderLegs: ladder?.legs?.length || 0,
    ctcFee: ctcSafety.feeUsdc?.toFixed(2) || null,
    bestInstrument: bestInstrument?.instrument || null
  });

  const premiumUsdc = premiumUsdcDecimal ? premiumUsdcDecimal.toFixed(2) : null;
  const premiumMarkupUsdc =
    passThroughFee && premiumUsdcDecimal
      ? passThroughFee.minus(premiumUsdcDecimal).toFixed(2)
      : null;
  const hedgeSize = size.toNumber();
  const expiryTag = bestInstrument?.instrument?.split("-")?.[1] || null;

  return {
    status: "ok",
    feeUsdc: feeUsdc ? feeUsdc.toFixed(2) : "0.00",
    baseFeeUsdc: baseFeeUsdc.toFixed(2),
    premiumMarkupPct: markupPct.mul(100).toFixed(2),
    premiumMarkupUsdc,
    reason: feeReason,
    ivBase: ctcSafety.baseIv,
    ivHedge: ctcSafety.hedgeIv,
    optionType,
    strike: bestInstrument ? bestInstrument.strike : targetStrikeNumber,
    spotPrice: spotNumber,
    drawdownFloorPct: drawdownFloorPct.toNumber(),
    targetStrike: targetStrikeNumber,
    hedge: bestInstrument
      ? {
          instrument: bestInstrument.instrument,
          size: hedgeSize,
          premiumUsdc,
          expiryTag,
          daysToExpiry: bestInstrument.tenorDays,
          strike: bestInstrument.strike
        }
      : {
          instrument: null,
          reason: "no_liquid_options",
          fallback: "perp"
        },
    debug:
      feeReason === "regime_fallback"
        ? {
            optionType,
            ladderReady: !!ladder,
            ladderLegs: ladder?.legs?.length || 0,
            spotPrice: spotNumber,
            targetStrike: targetStrikeNumber
          }
        : undefined
  };
});

app.get("/risk/mtm", async () => {
  if (!ALLOW_DERIBIT_PRIVATE_MTM) {
    return {
      status: "disabled",
      reason: "private_mtm_disabled",
      positionPnlUsdc: "0.0000",
      hedgeMtmUsdc: "0.0000",
      positions: []
    };
  }
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
  allowPartialCoverage?: boolean;
  _cacheBust?: boolean;
  _fastPreview?: boolean;
  _debugPassThrough?: boolean;
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
  body._fastPreview = true;
  body._cacheBust = true;
  const cacheKey = buildQuoteCacheKey(body);
  const cached = getQuoteCache(cacheKey);
  if (!body._cacheBust && cached && isQuoteCacheFresh(cached)) {
    return { ...cached.response, cached: true, stale: false };
  }
  const response = await startQuoteCompute(body, cacheKey);
  return { ...response, cached: Boolean(cached), stale: false };
});

app.post("/put/quote", async (req) => {
  const body = req.body as PutQuoteRequest;
  const requestStart = Date.now();
  const requestTimestamp = new Date().toISOString();
  Object.assign(riskControls, await loadRiskControls(RISK_CONTROLS_PATH));
  if (body.fixedPriceUsdc === undefined || body.fixedPriceUsdc === null) {
    body.fixedPriceUsdc = 0;
  }
  const quoteTtlMs = QUOTE_CACHE_TTL_MS;
  const cacheKey = buildQuoteCacheKey(body);
  const cached = getQuoteCache(cacheKey);
  const attachQuoteLock = (response: Record<string, unknown>, issuedAtMs?: number) => {
    const issuedAt = issuedAtMs ?? Date.now();
    const expiresAt = issuedAt + quoteTtlMs;
    const responseAny = { ...response } as any;
    const quoteId = responseAny.quoteId ?? randomUUID();
    responseAny.quoteId = quoteId;
    responseAny.quoteIssuedAt = new Date(issuedAt).toISOString();
    responseAny.quoteExpiresAt = new Date(expiresAt).toISOString();
    const feeRaw = Number(responseAny.feeUsdc ?? 0);
    const premiumTotalRaw = Number(
      responseAny.premiumUsdc ?? responseAny.rollEstimatedPremiumUsdc ?? 0
    );
    const premiumPerUnitRaw = Number(responseAny.premiumPerUnitUsdc ?? 0);
    const hedgeSizeRaw = Number(responseAny.hedgeSize ?? 0);
    const premiumPerUnit =
      Number.isFinite(premiumPerUnitRaw) && premiumPerUnitRaw > 0
        ? new Decimal(premiumPerUnitRaw)
        : Number.isFinite(premiumTotalRaw) &&
            premiumTotalRaw > 0 &&
            Number.isFinite(hedgeSizeRaw) &&
            hedgeSizeRaw > 0
          ? new Decimal(premiumTotalRaw).div(new Decimal(hedgeSizeRaw))
          : undefined;
    const instruments = extractQuoteInstruments(responseAny);
    if (Number.isFinite(feeRaw) && feeRaw > 0) {
      quoteLocks.set(quoteId, {
        feeUsdc: new Decimal(feeRaw),
        premiumTotalUsdc:
          Number.isFinite(premiumTotalRaw) && premiumTotalRaw > 0
            ? new Decimal(premiumTotalRaw)
            : undefined,
        premiumPerUnitUsdc: premiumPerUnit,
        hedgeSize:
          Number.isFinite(hedgeSizeRaw) && hedgeSizeRaw > 0
            ? new Decimal(hedgeSizeRaw)
            : undefined,
        issuedAt,
        expiresAt,
        tierName: String(body.tierName || "Unknown"),
        instruments
      });
    }
    return responseAny as Record<string, unknown>;
  };
  if (cached && isQuoteCacheFresh(cached)) {
    // Bypass cache only for explicit cache busting.
    if (body._cacheBust) {
      await audit("debug_cache_bypass", {
        tierName: body.tierName,
        side: body.side,
        cacheBust: body._cacheBust ?? null
      });
    } else {
      recordCacheHit(Date.now() - requestStart);
      return attachQuoteLock({
        ...cached.response,
        cached: true,
        responseTimeMs: Date.now() - requestStart,
        cachedAt: new Date(cached.ts).toISOString(),
        timestamp: requestTimestamp
      }, cached.ts);
    }
  }
  await audit("debug_quote_request", {
    tier: body.tierName,
    side: body.side,
    leverage: body.leverage,
    cached: cached ? "yes" : "no",
    cacheBust: body._cacheBust ?? null
  });
  const attachVenueMetadata = (response: Record<string, unknown>) => {
    if ((response as any).optionVenue || (response as any).venueComparison) return response;
    const snapshot = (response as any).selectionSnapshot as { books?: Array<any> } | null;
    if (!snapshot?.books || !Array.isArray(snapshot.books)) return response;
    const prices: Record<string, string> = {};
    let bestVenue: string | null = null;
    let bestAsk: Decimal | null = null;
    for (const book of snapshot.books) {
      const askRaw = book?.askUsd ?? null;
      if (askRaw === null || askRaw === undefined) continue;
      const askValue = new Decimal(askRaw);
      if (!askValue.isFinite() || askValue.lte(0)) continue;
      prices[book.venue] = askValue.toFixed(6);
      if (!bestAsk || askValue.lt(bestAsk)) {
        bestAsk = askValue;
        bestVenue = book.venue;
      }
    }
    if (!bestVenue || !bestAsk) return response;
    let savingsPerUnit = new Decimal(0);
    const alternatives = Object.entries(prices)
      .filter(([venue]) => venue !== bestVenue)
      .map(([, price]) => new Decimal(price));
    if (alternatives.length) {
      const bestAlt = alternatives.reduce((acc, val) => (val.lt(acc) ? val : acc));
      if (bestAlt.gt(bestAsk)) savingsPerUnit = bestAlt.minus(bestAsk);
    }
    const hedgeSizeRaw = (response as any).hedgeSize ?? "1";
    const hedgeSize = new Decimal(hedgeSizeRaw || 1);
    const savingsTotal = savingsPerUnit.mul(hedgeSize);
    (response as any).optionVenue = bestVenue;
    (response as any).venueComparison = {
      selected: bestVenue,
      prices,
      savingsPerUnitUsdc: savingsPerUnit.toFixed(2),
      savingsUsdc: savingsTotal.toFixed(2),
      queryTimeMs: null
    };
    return response;
  };

  const cacheAndReturn = async (response: Record<string, unknown>) => {
    const withVenue = attachVenueMetadata(response);
    const responseAny = withVenue as any;
    let strikeDetails = responseAny.strikeDetails ?? null;
    const strikeValue = Number(responseAny.strike ?? null);
    const targetStrikeValue = Number(responseAny.targetStrike ?? null);
    if (!strikeDetails && Number.isFinite(strikeValue) && Number.isFinite(targetStrikeValue)) {
      const delta = strikeValue - targetStrikeValue;
      const pct = targetStrikeValue ? (delta / targetStrikeValue) * 100 : 0;
      strikeDetails = {
        targetStrike: Number(targetStrikeValue.toFixed(4)),
        selectedStrike: Number(strikeValue.toFixed(4)),
        delta: Number(delta.toFixed(4)),
        pct: Number(pct.toFixed(4))
      };
    }
    const venueSelection = responseAny.venueSelection ?? {
      selected: responseAny.optionVenue ?? responseAny.venueComparison?.selected ?? null,
      prices: responseAny.venueComparison?.prices ?? null,
      savingsUsdc: responseAny.venueComparison?.savingsUsdc ?? null,
      savingsPerUnitUsdc: responseAny.venueComparison?.savingsPerUnitUsdc ?? null
    };
    const expirySelection = responseAny.expirySelection ?? {
      expiryTag: responseAny.expiryTag ?? null,
      targetDays: responseAny.targetDays ?? null
    };
    const withTiming = {
      ...withVenue,
      strikeDetails,
      venueSelection,
      expirySelection,
      cached: false,
      responseTimeMs: Date.now() - requestStart,
      optimizationMode: responseAny.optimizationMode ?? null,
      timestamp: requestTimestamp
    };
    const withLock = attachQuoteLock(withTiming);
    const venueComparison = (withVenue as any).venueComparison;
    if (venueComparison) {
      const prices = venueComparison.prices || {};
      await audit("venue_selection", {
        selectedVenue: venueComparison.selected,
        deribitAvailable: prices.deribit !== undefined,
        bybitAvailable: prices.bybit !== undefined,
        deribitPrice: prices.deribit ?? null,
        bybitPrice: prices.bybit ?? null,
        savingsUsdc: venueComparison.savingsUsdc ?? "0.00",
        savingsPerUnitUsdc: venueComparison.savingsPerUnitUsdc ?? "0.00",
        strike: (withVenue as any).strike ?? null,
        expiryTag: (withVenue as any).expiryTag ?? null,
        optionType: (withVenue as any).optionType ?? null,
        tierName: body.tierName ?? null,
        queryTimeMs: venueComparison.queryTimeMs ?? null
      });
    }
    setQuoteCache(cacheKey, withLock);
    recordCacheMiss(Date.now() - requestStart);
    return withLock;
  };

  const asset = (body.asset || "BTC").toUpperCase();
  if (asset !== "BTC") {
    return cacheAndReturn({
      status: "no_quote",
      reason: "unsupported_asset"
    });
  }
  const instruments = await deribit.listInstruments(asset);
  const results = (instruments as any)?.result || [];
  if (!results.length) {
    return cacheAndReturn({
      status: "no_quote",
      reason: "unsupported_asset"
    });
  }
  if (!results.length) {
    return cacheAndReturn({
      status: "no_quote",
      expiryTag: "",
      targetDays: 0,
      reason: "unsupported_asset"
    });
  }
  const useBodySpread = body.maxSpreadPct !== undefined;
  const useBodySlippage = body.maxSlippagePct !== undefined;
  const baseMaxSpreadPct = useBodySpread
    ? body.maxSpreadPct
    : (riskControls.max_spread_pct ?? 0.05);
  const effectiveMaxSpreadPct =
    venueConfig.mode === "bybit_only" && !useBodySpread
      ? Math.max(baseMaxSpreadPct, 0.08)
      : baseMaxSpreadPct;
  const baseMaxSlippagePct = useBodySlippage
    ? body.maxSlippagePct
    : (riskControls.max_slippage_pct ?? 0.01);
  const minSize = new Decimal(body.minSize ?? riskControls.min_option_size ?? 0.01);
  const positionSize = new Decimal(body.positionSize ?? 1);
  const contractSize = new Decimal(body.contractSize ?? 1);
  const leverageCheck = normalizeLeverage(body.leverage);
  if (!leverageCheck.ok) {
    return cacheAndReturn({
      status: "no_quote",
      reason: "invalid_leverage",
      maxLeverage: leverageCheck.max
    });
  }
  const leverage = leverageCheck.value;
  const hedgeSize = body.optionDelta
    ? hedgeSizeFromDelta(new Decimal(positionSize), new Decimal(body.optionDelta))
    : hedgeSizeFromNotional(positionSize, contractSize);
  const requiredSize = Decimal.max(minSize, hedgeSize);
  let hedgeSizeForQuote = requiredSize;

  const optionType = body.side === "short" ? "call" : "put";
  const spotPrice = new Decimal(body.spotPrice);
  const drawdownFloorPct = new Decimal(body.drawdownFloorPct);
  const targetStrike =
    optionType === "put"
      ? spotPrice.mul(new Decimal(1).minus(drawdownFloorPct))
      : spotPrice.mul(new Decimal(1).plus(drawdownFloorPct));
  const tierName = body.tierName || "Unknown";
  const tierLeverageLimits = riskControls.max_leverage_by_tier?.[tierName];
  if (tierLeverageLimits) {
    const maxLeverageForOption = tierLeverageLimits[optionType];
    if (Number.isFinite(maxLeverageForOption) && leverage > maxLeverageForOption) {
      await audit("leverage_validation_failed", {
        tierName,
        side: body.side,
        optionType,
        requestedLeverage: leverage,
        maxAllowed: maxLeverageForOption
      });
      const currentDays = body.targetDays ?? riskControls.default_target_days ?? 7;
      return cacheAndReturn({
        status: "error",
        error: "leverage_exceeded",
        message: `${tierName} supports ${optionType} protection up to ${maxLeverageForOption}× leverage.`,
        details: {
          tierName,
          optionType,
          requestedLeverage: leverage,
          maxAllowed: maxLeverageForOption
        },
        suggestions: [
          `Reduce leverage to ${maxLeverageForOption}× or below`,
          `Shorten duration (try 3-7 days)`,
          "Increase drawdown floor percentage"
        ]
      });
    }
  }
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
  const fastPreview = body._fastPreview === true;
  const expirySearchOrder = body.expiryTag
    ? [{ expiryTag: body.expiryTag, targetDays: expiryTargetDays ?? targetDays }]
    : venueConfig.mode === "bybit_only"
      ? buildBybitExpirySearchOrder(targetDays, 3)
      : await buildExpirySearchOrder(
          results,
          optionType,
          spotPrice,
          drawdownFloorPct,
          requiredSize,
          new Decimal(effectiveMaxSpreadPct ?? 0.05),
          targetDays,
          maxPreferredDays,
          maxFallbackDays
        );
  const effectiveExpiryOrder = fastPreview ? expirySearchOrder.slice(0, 1) : expirySearchOrder;
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
    hedgeSize: Decimal;
  } | null = null;
  let bestPlanLegs:
    | Array<{
        instrument: string;
        size: number;
        venue?: string | null;
        optionType?: "put" | "call" | null;
        strike?: number | null;
      }>
    | null = null;
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

  const overridePasses = fastPreview ? [false] : [false, true];
  let fastPreviewHit = false;
  for (const overridePass of overridePasses) {
    if (overridePass && !liquidityOverrideEnabled) break;
    bestCandidate = null;
    bestSnapshots = null;
    chosenExecutionPlans = null;
    chosenSnapshots = null;

    for (const entry of effectiveExpiryOrder) {
      const expiryTag = entry.expiryTag;
      const days = entry.targetDays;
      if (!expiryTag) continue;

      const plansByStrike = new Map<
        string,
        Array<{ venue: string; instrument: string; side: "buy" | "sell"; size: Decimal; price: Decimal }>
      >();
      const snapshotsByStrike = new Map<string, QuoteBookSnapshot[]>();
      const strikeCandidates =
        venueConfig.mode === "bybit_only"
          ? await selectBybitStrikeCandidates(
              asset,
              expiryTag,
              optionType,
              targetStrike,
              fastPreview ? 6 : 40
            )
          : selectStrikeCandidates(
              results,
              expiryTag,
              optionType,
              spotPrice,
              drawdownFloorPct,
              fastPreview ? 6 : 40
            );
      const { maxSpreadPct, maxSlippagePct } = resolveLiquidityThresholds(
        days,
        overridePass,
        effectiveMaxSpreadPct ?? 0.05,
        baseMaxSlippagePct ?? 0.01,
        useBodySpread,
        useBodySlippage
      );

      const floorPrice = computeFloorPrice(spotPrice, drawdownFloorPct, optionType);
      let remainingCredit = spotPrice.sub(floorPrice).abs().mul(requiredSize);
      const planExecutionPlans: Array<{
        venue: string;
        instrument: string;
        side: "buy" | "sell";
        size: Decimal;
        price: Decimal;
      }> = [];
      const planSnapshots: Array<{ strike: string; books: QuoteBookSnapshot[] }> = [];
      let planPremium = new Decimal(0);
      let planSize = new Decimal(0);
      let firstLegIv: number | null = null;
      let firstLegSpread: Decimal | null = null;

      for (const inst of strikeCandidates) {
        if (remainingCredit.lte(0)) break;
        let quotes = await getOptionVenueQuotes(inst.instrument_name, spotPrice);
        if (!quotes.length) {
          rejected.missingBook += 1;
          continue;
        }
        const strike = new Decimal(inst.strike);
        const intrinsic = computeIntrinsicAtFloor({
          spotPrice,
          drawdownFloorPct,
          optionType,
          strike
        });
        if (intrinsic.lte(0)) {
          rejected.sizeTooSmall += 1;
          continue;
        }
        const sizeNeeded = remainingCredit.div(intrinsic);
        const targetSize = Decimal.max(minSize, sizeNeeded);
        let agg = aggregateOptionQuotes(quotes, "buy", targetSize);
        if (
          venueConfig.mode === "bybit_only" &&
          agg.filledSize.lt(targetSize) &&
          venueConfig.deribit_enabled
        ) {
          const deribitQuote = await fetchDeribitQuoteForInstrument(inst.instrument_name, spotPrice);
          if (deribitQuote) {
            quotes = [...quotes, deribitQuote];
            agg = aggregateOptionQuotes(quotes, "buy", targetSize);
          }
        }
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
        const availableSize = agg.totalAskSize;
        const sizeToTake = Decimal.min(targetSize, availableSize);
        if (sizeToTake.lte(0)) {
          rejected.sizeTooSmall += 1;
          continue;
        }
        const sizedAgg = aggregateOptionQuotes(quotes, "buy", sizeToTake);
        if (!sizedAgg.avgPrice || sizedAgg.filledSize.lte(0) || sizedAgg.filledSize.lt(sizeToTake)) {
          rejected.sizeTooSmall += 1;
          continue;
        }
        const legPremiumTotal = sizedAgg.avgPrice.mul(sizeToTake);
        planPremium = planPremium.add(legPremiumTotal);
        planSize = planSize.add(sizeToTake);
        remainingCredit = remainingCredit.sub(intrinsic.mul(sizeToTake));
        planExecutionPlans.push(...sizedAgg.plans);

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
        snapshotsByStrike.set(strike.toFixed(0), snapshots);
        planSnapshots.push({ strike: strike.toFixed(0), books: snapshots });

        if (firstLegIv === null) {
          const ticker = await deribit.getTicker(inst.instrument_name);
          firstLegIv = Number((ticker as any)?.result?.mark_iv ?? 0);
        }
        if (firstLegSpread === null) {
          firstLegSpread = sizedAgg.spread;
        }

        if (remainingCredit.lte(0)) {
          const rollMultiplier = Math.max(1, Math.ceil(targetDays / days));
          const allInPremium = planPremium.mul(new Decimal(rollMultiplier));
          if (!bestCandidate || (!fastPreview && allInPremium.lt(bestCandidate.allInPremium))) {
            const avgPremiumPerUnit = planSize.gt(0) ? planPremium.div(planSize) : new Decimal(0);
            bestCandidate = {
              expiryTag,
              targetDays: days,
              premiumPerUnit: avgPremiumPerUnit,
              premiumTotal: planPremium,
              availableSize: planSize,
              strike,
              iv: firstLegIv ?? 0,
              spreadPct: firstLegSpread ?? sizedAgg.spread,
              rollMultiplier,
              allInPremium,
              hedgeSize: planSize
            };
            bestSnapshots = planSnapshots[0]?.books ?? snapshots;
            chosenExecutionPlans = planExecutionPlans;
            chosenSnapshots = snapshotsByStrike;
            bestPlanLegs = buildCoverageLegsFromPlans(planExecutionPlans);
          }
          if (fastPreview && bestCandidate) {
            fastPreviewHit = true;
            break;
          }
        }
      }
      if (fastPreviewHit) break;
    }
    if (fastPreviewHit) break;

    if (bestCandidate) {
      liquidityOverrideUsed = overridePass;
      const targetStrikeNumber = targetStrike.toNumber();
      const selectedStrikeNumber = bestCandidate.strike.toNumber();
      const strikeDelta = selectedStrikeNumber - targetStrikeNumber;
      const strikePct = targetStrikeNumber
        ? (strikeDelta / targetStrikeNumber) * 100
        : 0;
      console.log(
        `[StrikeDetails] target=${targetStrikeNumber.toFixed(2)} selected=${selectedStrikeNumber.toFixed(
          2
        )} delta=${strikeDelta.toFixed(2)} pct=${strikePct.toFixed(2)} expiry=${
          bestCandidate.expiryTag
        } days=${bestCandidate.targetDays}`
      );
      break;
    }
  }

  const quote = bestCandidate;
  if (quote?.hedgeSize) {
    hedgeSizeForQuote = quote.hedgeSize;
  }
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
      return cacheAndReturn({
        status: "no_quote",
        expiryTag: body.expiryTag || "",
        targetDays: 0,
        rejected,
        liquidityOverride: liquidityOverrideUsed
      });
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
      ivCandidate: candidateIv,
      optionType
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
      leverage,
      optionType
    });
    let feeReason = "flat_fee";
    if (tierName !== "Pro (Bronze)" && ctcSafety.feeUsdc && ctcSafety.feeUsdc.gt(feeUsdc)) {
      feeUsdc = ctcSafety.feeUsdc;
      feeReason = "ctc_safety";
    }
    const baseFeeUsdc = feeUsdc;
    const premiumTotal = bestCandidate.premiumTotal;
    const allInPremium = bestCandidate.allInPremium;
    const markupPct = resolvePremiumMarkupPct(tierName, leverage);
    const passThroughFee = allInPremium.mul(new Decimal(1).add(markupPct));
    const premiumFloor = premiumFloorBreached(allInPremium, baseFeeUsdc);
    const isPremiumTier =
      tierName === "Pro (Silver)" ||
      tierName === "Pro (Gold)" ||
      tierName === "Pro (Platinum)";
    const allowPartialCoverage = tierName === "Pro (Bronze)" && body.allowPartialCoverage === true;
    const passThroughEnabled = riskControls.enable_premium_pass_through !== false;
    const requiresUserOptIn = riskControls.require_user_opt_in_for_pass_through === true;
    const userOptedIn = body.allowPremiumPassThrough !== false;
    const canPassThrough = passThroughEnabled && (!requiresUserOptIn || userOptedIn);
    const passThroughCapInfo = applyPassThroughCap(
      baseFeeUsdc,
      allInPremium,
      leverage,
      tierName,
      feeIv.scaled ?? 0
    );
    const passThroughCapped = passThroughCapInfo.maxFee
      ? passThroughFee.gt(passThroughCapInfo.maxFee)
      : false;
    const uncappedBronzeEnabled = riskControls.pass_through_allow_uncapped_bronze === true;
    const uncappedMaxRatioRaw = riskControls.pass_through_uncapped_max_ratio ?? 0;
    const uncappedMaxRatioValue = Number(uncappedMaxRatioRaw);
    const uncappedMaxRatio =
      Number.isFinite(uncappedMaxRatioValue) && uncappedMaxRatioValue > 0
        ? new Decimal(uncappedMaxRatioValue)
        : null;
    const allowBronzeCapOverride =
      uncappedBronzeEnabled &&
      tierName === "Pro (Bronze)" &&
      (uncappedMaxRatio ? premiumFloor.ratio.lte(uncappedMaxRatio) : true);
    if (!premiumFloor.breached) {
      if (passThroughFee.gt(baseFeeUsdc)) {
        feeUsdc = passThroughFee;
        feeReason = "premium_markup";
      } else {
        feeUsdc = baseFeeUsdc;
        if (feeReason !== "ctc_safety") {
          feeReason = "base_fee";
        }
      }
    }
    let subsidyNeeded = allInPremium.minus(feeUsdc);
    let subsidyCheck = canApplySubsidy(
      tierName,
      body.accountId || null,
      subsidyNeeded.toNumber(),
      feeIv.scaled
    );
    await audit("pass_through_gate", {
      passThroughEnabled,
      requiresUserOptIn,
      userOptedIn,
      canPassThrough,
      tierName,
      leverage,
      premiumRatio: premiumFloor.ratio.toFixed(4)
    });
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
      hedgeSize: hedgeSizeForQuote,
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
    const canFullyCover = bestCandidate.availableSize.greaterThanOrEqualTo(hedgeSizeForQuote);

    if (premiumFloor.breached) {
      const minNotificationRatio = new Decimal(
        riskControls.pass_through_min_notification_ratio ?? 1.5
      );
      const shouldNotify = premiumFloor.ratio.gte(minNotificationRatio);
      const optionSymbol = optionType === "put" ? "P" : "C";
      const optionInstrument = buildVenueInstrumentName(
        asset,
        bestCandidate.expiryTag,
        bestCandidate.strike.toFixed(0),
        optionSymbol
      );
      const ratio = premiumFloor.ratio.toFixed(4);
      const threshold = premiumFloor.threshold.toFixed(4);

      if (canPassThrough && !passThroughCapped) {
        const venueInfo = attachVenueMetadata({
          selectionSnapshot: fallbackSnapshot,
          hedgeSize: hedgeSizeForQuote.toFixed(4)
        } as Record<string, unknown>);
        await audit("premium_pass_through", {
          type: "uncapped",
          baseFee: baseFeeUsdc.toFixed(2),
          allInPremium: allInPremium.toFixed(2),
          markupPct: markupPct.mul(100).toFixed(2),
          ratio,
          threshold,
          tierName,
          leverage,
          optionType,
          instrument: optionInstrument,
          optionVenue: (venueInfo as any).optionVenue ?? null,
          venueSavingsUsdc: (venueInfo as any).venueComparison?.savingsUsdc ?? "0.00"
        });
        return cacheAndReturn({
          status: "pass_through",
          expiryTag: bestCandidate.expiryTag,
          targetDays: bestCandidate.targetDays,
          optionType,
          strike: bestCandidate.strike.toFixed(0),
          instrument: optionInstrument,
          spotPrice: spotPrice.toNumber(),
          drawdownFloorPct: drawdownFloorPct.toNumber(),
          targetStrike: targetStrike.toNumber(),
          premiumUsdc: premiumTotal.toFixed(2),
          premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
          hedgeSize: hedgeSizeForQuote.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          subsidyUsdc: "0.00",
          baseFeeUsdc: baseFeeUsdc.toFixed(2),
          feeUsdc: passThroughFee.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
          passThroughCapped: false,
          reason: "premium_floor_pass_through",
          liquidityOverride: liquidityOverrideUsed,
          replication: fallbackReplication,
          survivalCheck,
          selectionSnapshot: fallbackSnapshot,
          rollMultiplier: bestCandidate.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
          hedge: {
            instrument: optionInstrument,
            size: hedgeSizeForQuote.toFixed(4),
            premiumUsdc: allInPremium.toFixed(2),
            expiryTag: bestCandidate.expiryTag,
            daysToExpiry: bestCandidate.targetDays,
            strike: bestCandidate.strike.toFixed(0)
          },
          pricing: {
            type: "pass_through",
            baseFee: baseFeeUsdc.toFixed(2),
            hedgePremium: allInPremium.toFixed(2),
            totalFee: passThroughFee.toFixed(2),
            markupPct: markupPct.mul(100).toFixed(2),
            markupUsdc: passThroughFee.minus(allInPremium).toFixed(2),
            ratio,
            threshold,
            explanation:
              `Market volatility requires premium ${premiumFloor.ratio.toFixed(2)}× base fee. ` +
              `Charging hedge premium plus markup for full protection.`
          },
          warning: shouldNotify
            ? {
                type: "premium_pass_through",
                ratio,
                threshold,
                message:
                  `Premium is ${premiumFloor.ratio.toFixed(2)}× the base fee due to market conditions. ` +
                  `You'll be charged the actual hedge cost of $${allInPremium.toFixed(2)}.`
              }
            : undefined
        });
      }

      if (canPassThrough && passThroughCapped && passThroughCapInfo.maxFee) {
        const cappedFee = passThroughCapInfo.maxFee;
        const subsidyNeededCapped = allInPremium.minus(cappedFee);
        if (!isPremiumTier) {
          if (allowBronzeCapOverride) {
            const venueInfo = attachVenueMetadata({
              selectionSnapshot: fallbackSnapshot,
              hedgeSize: hedgeSizeForQuote.toFixed(4)
            } as Record<string, unknown>);
            await audit("premium_pass_through", {
              type: "cap_override",
              baseFee: baseFeeUsdc.toFixed(2),
              allInPremium: allInPremium.toFixed(2),
              capMultiplier: passThroughCapInfo.capMultiplier
                ? formatCapMultiplier(passThroughCapInfo)
                : null,
              ratio,
              threshold,
              tierName,
              leverage,
              optionType,
              instrument: optionInstrument,
              optionVenue: (venueInfo as any).optionVenue ?? null,
              venueSavingsUsdc: (venueInfo as any).venueComparison?.savingsUsdc ?? "0.00"
            });
            const explanation =
              `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds Bronze tier cap ` +
              `of ${formatCapMultiplier(passThroughCapInfo, 1) || "N/A"}×. ` +
              `Charging the full hedge premium to keep protection active.`;
            return cacheAndReturn({
              status: "pass_through",
              expiryTag: bestCandidate.expiryTag,
              targetDays: bestCandidate.targetDays,
              optionType,
              strike: bestCandidate.strike.toFixed(0),
              instrument: optionInstrument,
              spotPrice: spotPrice.toNumber(),
              drawdownFloorPct: drawdownFloorPct.toNumber(),
              targetStrike: targetStrike.toNumber(),
              premiumUsdc: premiumTotal.toFixed(2),
              premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
              hedgeSize: hedgeSizeForQuote.toFixed(4),
              sizingMethod: body.optionDelta ? "delta" : "notional",
              bufferTargetPct: "0.00",
              markIv: feeIv.raw,
              subsidyUsdc: "0.00",
              baseFeeUsdc: baseFeeUsdc.toFixed(2),
              feeUsdc: passThroughFee.toFixed(2),
              feeRegime: feeRegime.regime,
              feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
              feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
              passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
              passThroughCapped: true,
              reason: "premium_floor_pass_through_override",
              liquidityOverride: liquidityOverrideUsed,
              replication: fallbackReplication,
              survivalCheck,
              selectionSnapshot: fallbackSnapshot,
              rollMultiplier: bestCandidate.rollMultiplier,
              rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
              hedge: {
                instrument: optionInstrument,
                size: hedgeSizeForQuote.toFixed(4),
                premiumUsdc: allInPremium.toFixed(2),
                expiryTag: bestCandidate.expiryTag,
                daysToExpiry: bestCandidate.targetDays,
                strike: bestCandidate.strike.toFixed(0)
              },
              pricing: {
                type: "pass_through_override",
                baseFee: baseFeeUsdc.toFixed(2),
                hedgePremium: allInPremium.toFixed(2),
                totalFee: passThroughFee.toFixed(2),
                markupPct: markupPct.mul(100).toFixed(2),
                markupUsdc: passThroughFee.minus(allInPremium).toFixed(2),
                ratio,
                threshold,
                capMultiplier: passThroughCapInfo.capMultiplier
                  ? formatCapMultiplier(passThroughCapInfo, 2)
                  : "N/A",
                explanation
              },
              warning: {
                type: "premium_pass_through_override",
                ratio,
                threshold,
                message: explanation
              }
            });
          }
          const rejectReason = "premium_floor_pass_through_capped";
          await audit("premium_floor_rejected", {
            baseFee: baseFeeUsdc.toFixed(2),
            allInPremium: allInPremium.toFixed(2),
            ratio,
            threshold,
            reason: rejectReason,
            canPassThrough,
            capped: true,
            capMultiplier: passThroughCapInfo.capMultiplier
              ? formatCapMultiplier(passThroughCapInfo)
              : null,
            tierName,
            leverage,
            optionType,
            instrument: optionInstrument
          });
          await audit("debug_feasibility_search_start", {
            tierName,
            optionType,
            leverage,
            targetDays,
            premium: allInPremium.toFixed(2),
            cap: cappedFee.toFixed(2)
          });
          // Bronze tier does not receive capped pass-through subsidy.
          const feasibility = null;
          await audit("debug_feasibility_search_result", {
            found: feasibility?.found ?? false,
            suggestionType: feasibility?.suggestion?.type,
            newLeverage: feasibility?.suggestion?.newLeverage,
            newDuration: feasibility?.suggestion?.newDuration,
            estimatedPremium: feasibility?.suggestion?.estimatedPremium?.toFixed(2)
          });
          const leverageSuggestion = Math.max(1, Math.floor(leverage / 2));
          const suggestedCap = resolvePassThroughCapMultiplier(leverageSuggestion, tierName);
          const currentDays = bestCandidate.targetDays;
          const currentFloorPct = drawdownFloorPct.toNumber();
          const enhancedMessage =
            optionType === "call" && tierName === "Pro (Bronze)"
              ? `Bronze tier call protection limit reached. Current request: ` +
                `${leverage}× leverage, ${currentDays} days, ${(currentFloorPct * 100).toFixed(
                  0
                )}% floor.`
              : "Protection cost exceeds Bronze tier limits for this request.";
          const baseSuggestions = [
            `Reduce leverage from ${leverage}× to ${leverageSuggestion}× ` +
              `(cap ${suggestedCap ? `${suggestedCap.toFixed(1)}×` : "N/A"})`,
            `Reduce protection duration from ${currentDays} days to ${Math.max(
              1,
              Math.floor(currentDays / 2)
            )} days`,
            `Increase drawdown floor to ${Math.min(0.25, currentFloorPct + 0.05).toFixed(2)}`,
            "Reduce position size to lower premium"
          ];
          const dynamicSuggestions = baseSuggestions;
          return cacheAndReturn({
            status: "premium_floor",
            expiryTag: bestCandidate.expiryTag,
            targetDays: bestCandidate.targetDays,
            optionType,
            strike: bestCandidate.strike.toFixed(0),
            instrument: optionInstrument,
            spotPrice: spotPrice.toNumber(),
            premiumUsdc: premiumTotal.toFixed(2),
            premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
            hedgeSize: hedgeSizeForQuote.toFixed(4),
            sizingMethod: body.optionDelta ? "delta" : "notional",
            bufferTargetPct: "0.00",
            markIv: feeIv.raw,
            subsidyUsdc: "0.00",
            baseFeeUsdc: baseFeeUsdc.toFixed(2),
            feeUsdc: baseFeeUsdc.toFixed(2),
            feeRegime: feeRegime.regime,
            feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
            feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
            passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
            passThroughCapped: true,
            reason: rejectReason,
            liquidityOverride: liquidityOverrideUsed,
            replication: fallbackReplication,
            survivalCheck,
            selectionSnapshot: fallbackSnapshot,
            rollMultiplier: bestCandidate.rollMultiplier,
            rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
            message: enhancedMessage,
            details:
              optionType === "call" && tierName === "Pro (Bronze)"
                ? {
                    requestedPremium: premiumTotal.toFixed(2),
                    tierCap: cappedFee.toFixed(2),
                    exceedAmount: premiumTotal.minus(cappedFee).toFixed(2),
                    currentParams: {
                      leverage,
                      duration: currentDays,
                      drawdownFloor: currentFloorPct
                    }
                  }
                : undefined,
            // No guaranteed_working_option for Bronze
            pricing: {
              baseFee: baseFeeUsdc.toFixed(2),
              hedgePremium: allInPremium.toFixed(2),
              ratio,
              threshold,
              capMultiplier: passThroughCapInfo.capMultiplier
                ? formatCapMultiplier(passThroughCapInfo, 2)
                : "N/A",
              explanation:
                `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds Bronze tier cap ` +
                `of ${formatCapMultiplier(passThroughCapInfo, 1) || "N/A"}×. ` +
                `Reduce leverage, duration, or widen the floor to lower premium.`
            },
            warning: {
              type: "premium_floor",
              ratio,
              threshold,
              message:
                "Premium too high for Bronze tier. Reduce leverage, duration, or widen the floor."
            },
            suggestions: dynamicSuggestions
          });
        }
        const subsidyCheckCapped = subsidyNeededCapped.gt(0)
          ? canApplySubsidy(
              tierName,
              body.accountId || null,
              subsidyNeededCapped.toNumber(),
              feeIv.scaled
            )
          : { allowed: true, reason: "ok" };
        if (subsidyNeededCapped.gt(0) && !subsidyCheckCapped.allowed) {
          const rejectReason = "premium_floor_pass_through_capped";
          await audit("premium_floor_rejected", {
            baseFee: baseFeeUsdc.toFixed(2),
            allInPremium: allInPremium.toFixed(2),
            ratio,
            threshold,
            reason: rejectReason,
            canPassThrough,
            capped: true,
            capMultiplier: passThroughCapInfo.capMultiplier
              ? formatCapMultiplier(passThroughCapInfo)
              : null,
            tierName,
            leverage,
            optionType,
            instrument: optionInstrument
          });
          const leverageSuggestion = Math.max(1, Math.floor(leverage / 2));
          const suggestedCap = resolvePassThroughCapMultiplier(leverageSuggestion, tierName);
          return cacheAndReturn({
            status: "premium_floor",
            expiryTag: bestCandidate.expiryTag,
            targetDays: bestCandidate.targetDays,
            optionType,
            strike: bestCandidate.strike.toFixed(0),
            instrument: optionInstrument,
            spotPrice: spotPrice.toNumber(),
            premiumUsdc: premiumTotal.toFixed(2),
            premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
            hedgeSize: hedgeSizeForQuote.toFixed(4),
            sizingMethod: body.optionDelta ? "delta" : "notional",
            bufferTargetPct: "0.00",
            markIv: feeIv.raw,
            subsidyUsdc: "0.00",
            baseFeeUsdc: baseFeeUsdc.toFixed(2),
            feeUsdc: baseFeeUsdc.toFixed(2),
            feeRegime: feeRegime.regime,
            feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
            feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
            passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
            passThroughCapped: true,
            reason: rejectReason,
            liquidityOverride: liquidityOverrideUsed,
            replication: fallbackReplication,
            survivalCheck,
            selectionSnapshot: fallbackSnapshot,
            rollMultiplier: bestCandidate.rollMultiplier,
            rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
            pricing: {
              baseFee: baseFeeUsdc.toFixed(2),
              hedgePremium: allInPremium.toFixed(2),
              ratio,
              threshold,
              capMultiplier: passThroughCapInfo.capMultiplier
                ? formatCapMultiplier(passThroughCapInfo, 2)
                : "N/A",
              explanation:
                `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds maximum ` +
                `${formatCapMultiplier(passThroughCapInfo, 1) || "N/A"}× cap for ${tierName} at ${leverage}× leverage. ` +
                `Try: lower leverage, shorter duration, wider floor, or smaller size.`
            },
            warning: {
              type: "premium_floor",
              ratio,
              threshold,
              message:
                `Premium too high for ${tierName} tier at ${leverage}× leverage. ` +
                `Reduce leverage, duration, or widen the floor.`
            },
            suggestions: [
              `Reduce leverage from ${leverage}× to ${leverageSuggestion}× ` +
                `(cap ${suggestedCap ? `${suggestedCap.toFixed(1)}×` : "N/A"})`,
              `Reduce protection duration from ${bestCandidate.targetDays} days to ${Math.max(
                1,
                Math.floor(bestCandidate.targetDays / 2)
              )} days`,
              "Increase drawdown floor percentage to reduce premium",
              "Reduce position size to lower premium"
            ]
          });
        }

        const venueInfo = attachVenueMetadata({
          selectionSnapshot: fallbackSnapshot,
          hedgeSize: hedgeSizeForQuote.toFixed(4)
        } as Record<string, unknown>);
        await audit("premium_pass_through", {
          type: "capped",
          baseFee: baseFeeUsdc.toFixed(2),
          allInPremium: allInPremium.toFixed(2),
          cappedFee: cappedFee.toFixed(2),
          capMultiplier: passThroughCapInfo.capMultiplier
            ? formatCapMultiplier(passThroughCapInfo)
            : null,
          ratio,
          tierName,
          leverage,
          optionType,
          instrument: optionInstrument,
          optionVenue: (venueInfo as any).optionVenue ?? null,
          venueSavingsUsdc: (venueInfo as any).venueComparison?.savingsUsdc ?? "0.00"
        });
        return cacheAndReturn({
          status: "pass_through_capped",
          expiryTag: bestCandidate.expiryTag,
          targetDays: bestCandidate.targetDays,
          optionType,
          strike: bestCandidate.strike.toFixed(0),
          instrument: optionInstrument,
          spotPrice: spotPrice.toNumber(),
          drawdownFloorPct: drawdownFloorPct.toNumber(),
          targetStrike: targetStrike.toNumber(),
          premiumUsdc: premiumTotal.toFixed(2),
          premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
          hedgeSize: hedgeSizeForQuote.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          subsidyUsdc: subsidyNeededCapped.toFixed(2),
          baseFeeUsdc: baseFeeUsdc.toFixed(2),
          feeUsdc: cappedFee.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
          passThroughCapped: true,
          reason: "premium_floor_pass_through_capped",
          liquidityOverride: liquidityOverrideUsed,
          replication: fallbackReplication,
          survivalCheck,
          selectionSnapshot: fallbackSnapshot,
          rollMultiplier: bestCandidate.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
          hedge: {
            instrument: optionInstrument,
            size: hedgeSizeForQuote.toFixed(4),
            premiumUsdc: allInPremium.toFixed(2),
            expiryTag: bestCandidate.expiryTag,
            daysToExpiry: bestCandidate.targetDays,
            strike: bestCandidate.strike.toFixed(0)
          },
          pricing: {
            type: "pass_through_capped",
            baseFee: baseFeeUsdc.toFixed(2),
            hedgePremium: allInPremium.toFixed(2),
            cappedFee: cappedFee.toFixed(2),
            capMultiplier: passThroughCapInfo.capMultiplier
              ? formatCapMultiplier(passThroughCapInfo, 2)
              : "N/A",
            platformSubsidy: subsidyNeededCapped.toFixed(2),
            totalFee: cappedFee.toFixed(2),
            ratio,
            threshold,
            explanation:
              `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds ${tierName} tier cap. ` +
              `Fee capped at $${cappedFee.toFixed(2)} ` +
              `(${formatCapMultiplier(passThroughCapInfo, 1) || "N/A"}× base). ` +
              `Platform subsidizing $${subsidyNeededCapped.toFixed(2)} for full protection.`
          },
          warning: shouldNotify
            ? {
                type: "premium_capped",
                ratio,
                threshold,
                message:
                  `Premium exceeds tier cap. Fee capped at $${cappedFee.toFixed(2)}. ` +
                  `You're still fully protected.`
              }
            : undefined
        });
      }

      const rejectReason = passThroughCapped
        ? "premium_floor_pass_through_capped"
        : "premium_floor_no_pass_through";
      await audit("premium_floor_rejected", {
        baseFee: baseFeeUsdc.toFixed(2),
        allInPremium: allInPremium.toFixed(2),
        ratio,
        threshold,
        reason: rejectReason,
        canPassThrough,
        capped: passThroughCapped,
        capMultiplier: passThroughCapInfo.capMultiplier
          ? formatCapMultiplier(passThroughCapInfo)
          : null,
        tierName,
        leverage,
        optionType,
        instrument: optionInstrument
      });
      await audit("debug_feasibility_search_start", {
        tierName,
        optionType,
        leverage,
        targetDays,
        premium: allInPremium.toFixed(2),
        cap: passThroughCapInfo.maxFee ? passThroughCapInfo.maxFee.toFixed(2) : null
      });
      // Bronze tier does not receive capped pass-through subsidy.
      const feasibility = null;
      await audit("debug_feasibility_search_result", {
        found: feasibility?.found ?? false,
        suggestionType: feasibility?.suggestion?.type,
        newLeverage: feasibility?.suggestion?.newLeverage,
        newDuration: feasibility?.suggestion?.newDuration,
        estimatedPremium: feasibility?.suggestion?.estimatedPremium?.toFixed(2)
      });
      const currentDays = bestCandidate.targetDays;
      const currentFloorPct = drawdownFloorPct.toNumber();
      const baseSuggestions = passThroughCapped
        ? [
            `Reduce leverage from ${leverage}× to ${Math.max(1, Math.floor(leverage / 2))}×`,
            `Reduce protection duration from ${currentDays} days to ${Math.max(
              1,
              Math.floor(currentDays / 2)
            )} days`,
            "Increase drawdown floor percentage to reduce premium",
            "Reduce position size to lower premium"
          ]
        : [
            "Reduce leverage or duration to lower premium",
            "Increase drawdown floor percentage to reduce premium",
            "Contact support to enable premium pass-through"
          ];
      const dynamicSuggestions = baseSuggestions;
      return cacheAndReturn({
        status: "premium_floor",
        expiryTag: bestCandidate.expiryTag,
        targetDays: bestCandidate.targetDays,
        optionType,
        strike: bestCandidate.strike.toFixed(0),
        instrument: optionInstrument,
        spotPrice: spotPrice.toNumber(),
        premiumUsdc: premiumTotal.toFixed(2),
        premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
        hedgeSize: hedgeSizeForQuote.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: "0.00",
        markIv: feeIv.raw,
        subsidyUsdc: "0.00",
        baseFeeUsdc: baseFeeUsdc.toFixed(2),
        feeUsdc: baseFeeUsdc.toFixed(2),
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
        passThroughCapped: passThroughCapped,
        reason: rejectReason,
        liquidityOverride: liquidityOverrideUsed,
        replication: fallbackReplication,
        survivalCheck,
        selectionSnapshot: fallbackSnapshot,
        rollMultiplier: bestCandidate.rollMultiplier,
        rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
        // No guaranteed_working_option for Bronze
        pricing: {
          baseFee: baseFeeUsdc.toFixed(2),
          hedgePremium: allInPremium.toFixed(2),
          ratio,
          threshold,
          capMultiplier: passThroughCapInfo.capMultiplier
            ? formatCapMultiplier(passThroughCapInfo, 2)
            : "N/A",
          explanation: passThroughCapped
            ? `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds maximum ` +
              `${formatCapMultiplier(passThroughCapInfo, 1) || "N/A"}× cap for ${tierName} at ${leverage}× leverage. ` +
              `Try: lower leverage, shorter duration, wider floor, or smaller size.`
            : `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds threshold. ` +
              `Pass-through not enabled. Contact support if you need higher limits.`
        },
        warning: {
          type: "premium_floor",
          ratio,
          threshold,
          message: passThroughCapped
            ? `Premium too high for ${tierName} tier at ${leverage}× leverage. ` +
              `Reduce leverage, duration, or widen the floor.`
            : `Premium ${premiumFloor.ratio.toFixed(2)}× base fee cannot be accommodated.`
        },
        suggestions: dynamicSuggestions
      });
    }

    if (subsidyNeeded.gt(0) && subsidyCheck.allowed && canFullyCover) {
      const optionSymbol = optionType === "put" ? "P" : "C";
      const optionInstrument = buildVenueInstrumentName(
        asset,
        bestCandidate.expiryTag,
        bestCandidate.strike.toFixed(0),
        optionSymbol
      );
      return cacheAndReturn({
        status: "subsidized",
        expiryTag: bestCandidate.expiryTag,
        targetDays: bestCandidate.targetDays,
        optionType,
        strike: bestCandidate.strike.toFixed(0),
        instrument: optionInstrument,
        premiumUsdc: premiumTotal.toFixed(2),
        premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
        hedgeSize: hedgeSizeForQuote.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: "0.00",
        markIv: feeIv.raw,
        subsidyUsdc: subsidyNeeded.toFixed(2),
        feeUsdc: feeUsdc.toFixed(2),
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
        passThroughCapped: passThroughCapped,
        reason: "subsidized",
        capBreached: false,
        liquidityOverride: liquidityOverrideUsed,
        replication: fallbackReplication,
        survivalCheck,
        selectionSnapshot: fallbackSnapshot,
        rollMultiplier: bestCandidate.rollMultiplier,
        rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
      });
    }

    if (subsidyNeeded.gt(0) && canFullyCover && canCoverageOverride(tierName)) {
      const optionSymbol = optionType === "put" ? "P" : "C";
      const optionInstrument = buildVenueInstrumentName(
        asset,
        bestCandidate.expiryTag,
        bestCandidate.strike.toFixed(0),
        optionSymbol
      );
      return cacheAndReturn({
        status: "subsidized",
        expiryTag: bestCandidate.expiryTag,
        targetDays: bestCandidate.targetDays,
        optionType,
        strike: bestCandidate.strike.toFixed(0),
        instrument: optionInstrument,
        premiumUsdc: premiumTotal.toFixed(2),
        premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
        hedgeSize: hedgeSizeForQuote.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: "0.00",
        markIv: feeIv.raw,
        subsidyUsdc: subsidyNeeded.toFixed(2),
        feeUsdc: feeUsdc.toFixed(2),
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
        passThroughCapped: passThroughCapped,
        reason: "coverage_override",
        capBreached: true,
        subsidyCapReason: subsidyCheck.reason,
        liquidityOverride: liquidityOverrideUsed,
        replication: fallbackReplication,
        survivalCheck,
        selectionSnapshot: fallbackSnapshot,
        rollMultiplier: bestCandidate.rollMultiplier,
        rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
      });
    }

    if (canPassThrough && allInPremium.gt(feeUsdc)) {
      const passThroughCapInfoLate = applyPassThroughCap(
        baseFeeUsdc,
        allInPremium,
        leverage,
        tierName,
        feeIv.scaled ?? 0
      );
      if (!passThroughCapInfoLate.capped) {
        const optionSymbol = optionType === "put" ? "P" : "C";
        const optionInstrument = buildVenueInstrumentName(
          asset,
          bestCandidate.expiryTag,
          bestCandidate.strike.toFixed(0),
          optionSymbol
        );
        return cacheAndReturn({
          status: "pass_through",
          expiryTag: bestCandidate.expiryTag,
          targetDays: bestCandidate.targetDays,
          optionType,
          strike: bestCandidate.strike.toFixed(0),
          instrument: optionInstrument,
          premiumUsdc: premiumTotal.toFixed(2),
          premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
          hedgeSize: hedgeSizeForQuote.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          subsidyUsdc: "0.00",
          feeUsdc: passThroughFee.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfoLate),
          passThroughCapped: false,
          reason: "pass_through",
          liquidityOverride: liquidityOverrideUsed,
          replication: fallbackReplication,
          survivalCheck,
          selectionSnapshot: fallbackSnapshot,
          rollMultiplier: bestCandidate.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2)
        });
      }
    }

    const affordableSize = feeUsdc.div(
      bestCandidate.premiumPerUnit.mul(new Decimal(bestCandidate.rollMultiplier))
    );
    const partialSize = Decimal.min(bestCandidate.availableSize, affordableSize);
    if (partialSize.greaterThanOrEqualTo(minSize)) {
      if (!allowPartialCoverage) {
        await audit("premium_floor_rejected", {
          baseFee: baseFeeUsdc.toFixed(2),
          allInPremium: allInPremium.toFixed(2),
          ratio: premiumFloor.ratio.toFixed(4),
          threshold: premiumFloor.threshold.toFixed(4),
          reason: "partial_not_allowed",
          canPassThrough,
          capped: passThroughCapped,
          capMultiplier: passThroughCapInfo.capMultiplier
            ? formatCapMultiplier(passThroughCapInfo)
            : null,
          tierName,
          leverage,
          optionType
        });
        return cacheAndReturn({
          status: "premium_floor",
          expiryTag: bestCandidate.expiryTag,
          targetDays: bestCandidate.targetDays,
          optionType,
          strike: bestCandidate.strike.toFixed(0),
          premiumUsdc: bestCandidate.premiumPerUnit.mul(partialSize).toFixed(2),
          premiumPerUnitUsdc: bestCandidate.premiumPerUnit.toFixed(2),
          hedgeSize: hedgeSizeForQuote.toFixed(4),
          sizingMethod: body.optionDelta ? "delta" : "notional",
          bufferTargetPct: "0.00",
          markIv: feeIv.raw,
          subsidyUsdc: "0.00",
          baseFeeUsdc: baseFeeUsdc.toFixed(2),
          feeUsdc: feeUsdc.toFixed(2),
          feeRegime: feeRegime.regime,
          feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
          feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
          passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
          passThroughCapped: passThroughCapped,
          reason: "partial_not_allowed",
          liquidityOverride: liquidityOverrideUsed,
          replication: fallbackReplication,
          survivalCheck,
          selectionSnapshot: fallbackSnapshot,
          rollMultiplier: bestCandidate.rollMultiplier,
          rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
          warning: {
            type: "premium_floor",
            ratio: premiumFloor.ratio.toFixed(4),
            threshold: premiumFloor.threshold.toFixed(4),
            message:
              "Partial coverage not allowed for this tier. Reduce leverage, duration, or widen the floor."
          },
          suggestions: [
            "Reduce leverage to lower hedge premium",
            "Shorten duration to reduce premium",
            "Increase drawdown floor percentage to reduce premium"
          ]
        });
      }
      const coverageRatio = partialSize.div(requiredSize);
      const discountedFee = applyPartialDiscount(feeUsdc, coverageRatio);
      const optionSymbol = optionType === "put" ? "P" : "C";
      const optionInstrument = buildVenueInstrumentName(
        asset,
        bestCandidate.expiryTag,
        bestCandidate.strike.toFixed(0),
        optionSymbol
      );
      return cacheAndReturn({
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
        passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
        passThroughCapped: passThroughCapped,
        reason: "partial",
        liquidityOverride: liquidityOverrideUsed,
        replication: fallbackReplication,
        survivalCheck,
        selectionSnapshot: fallbackSnapshot,
        rollMultiplier: bestCandidate.rollMultiplier,
        rollEstimatedPremiumUsdc: allInPremium.toFixed(2),
        coveragePct: coverageRatio.mul(100).toFixed(2),
        feeDiscountPct: (riskControls.partial_coverage_discount_pct ?? 0) * 100
      });
    }

    return cacheAndReturn({
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
    });
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
    ivCandidate: quoteIv,
    optionType
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
    leverage,
    optionType
  });
  let feeReason = "flat_fee";
  if (tierName !== "Pro (Bronze)" && ctcSafety.feeUsdc && ctcSafety.feeUsdc.gt(feeUsdc)) {
    feeUsdc = ctcSafety.feeUsdc;
    feeReason = "ctc_safety";
  }
  const baseFeeUsdc = feeUsdc;
  const allInPremium = quote.allInPremium;
  const markupPct = resolvePremiumMarkupPct(tierName, leverage);
  const passThroughFee = allInPremium.mul(new Decimal(1).add(markupPct));
  const premiumFloor = premiumFloorBreached(allInPremium, baseFeeUsdc);
  const isPremiumTier =
    tierName === "Pro (Silver)" ||
    tierName === "Pro (Gold)" ||
    tierName === "Pro (Platinum)";
  const allowPartialCoverage = tierName === "Pro (Bronze)" && body.allowPartialCoverage === true;
  const passThroughEnabled = riskControls.enable_premium_pass_through !== false;
  const requiresUserOptIn = riskControls.require_user_opt_in_for_pass_through === true;
  const userOptedIn = body.allowPremiumPassThrough !== false;
  const canPassThrough = passThroughEnabled && (!requiresUserOptIn || userOptedIn);
  const passThroughCapInfo = applyPassThroughCap(
    baseFeeUsdc,
    allInPremium,
    leverage,
    tierName,
    feeIv.scaled ?? 0
  );
  const passThroughCapped = passThroughCapInfo.maxFee
    ? passThroughFee.gt(passThroughCapInfo.maxFee)
    : false;
  const uncappedBronzeEnabled = riskControls.pass_through_allow_uncapped_bronze === true;
  const uncappedMaxRatioRaw = riskControls.pass_through_uncapped_max_ratio ?? 0;
  const uncappedMaxRatioValue = Number(uncappedMaxRatioRaw);
  const uncappedMaxRatio =
    Number.isFinite(uncappedMaxRatioValue) && uncappedMaxRatioValue > 0
      ? new Decimal(uncappedMaxRatioValue)
      : null;
  const allowBronzeCapOverride =
    uncappedBronzeEnabled &&
    tierName === "Pro (Bronze)" &&
    (uncappedMaxRatio ? premiumFloor.ratio.lte(uncappedMaxRatio) : true);
  if (!premiumFloor.breached) {
    if (passThroughFee.gt(baseFeeUsdc)) {
      feeUsdc = passThroughFee;
      feeReason = "premium_markup";
    } else {
      feeUsdc = baseFeeUsdc;
      if (feeReason !== "ctc_safety") {
        feeReason = "base_fee";
      }
    }
  }
  await audit("pass_through_gate", {
    passThroughEnabled,
    requiresUserOptIn,
    userOptedIn,
    canPassThrough,
    tierName,
    leverage,
    premiumRatio: premiumFloor.ratio.toFixed(4)
  });
  const canFullyCoverQuote = quote.availableSize.greaterThanOrEqualTo(hedgeSizeForQuote);
  if (premiumFloor.breached && canPassThrough && passThroughCapped && passThroughCapInfo.maxFee) {
    const cappedFee = passThroughCapInfo.maxFee;
    const optionSymbol = optionType === "put" ? "P" : "C";
    const optionInstrument = buildVenueInstrumentName(
      asset,
      quote.expiryTag || "",
      quote.strike.toFixed(0),
      optionSymbol
    );
    const passThroughDebug = body._debugPassThrough
      ? {
          tierName,
          canPassThrough,
          passThroughCapped,
          premiumRatio: premiumFloor.ratio.toFixed(4),
          uncappedBronzeEnabled,
          uncappedMaxRatio: uncappedMaxRatio ? uncappedMaxRatio.toFixed(4) : null,
          allowBronzeCapOverride
        }
      : undefined;
    if (allowBronzeCapOverride) {
      const venueInfo = attachVenueMetadata({
        selectionSnapshot: bestSnapshots
          ? {
              expiryTag: quote.expiryTag,
              targetDays: quote.targetDays,
              strike: quote.strike.toFixed(0),
              books: bestSnapshots
            }
          : null,
        hedgeSize: hedgeSizeForQuote.toFixed(4)
      } as Record<string, unknown>);
      await audit("premium_pass_through", {
        type: "cap_override",
        baseFee: baseFeeUsdc.toFixed(2),
        allInPremium: allInPremium.toFixed(2),
        capMultiplier: passThroughCapInfo.capMultiplier
          ? formatCapMultiplier(passThroughCapInfo)
          : null,
        ratio: premiumFloor.ratio.toFixed(4),
        tierName,
        leverage,
        optionType,
        instrument: optionInstrument,
        optionVenue: (venueInfo as any).optionVenue ?? null,
        venueSavingsUsdc: (venueInfo as any).venueComparison?.savingsUsdc ?? "0.00"
      });
      const explanation =
        `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds Bronze tier cap ` +
        `of ${formatCapMultiplier(passThroughCapInfo, 1) || "N/A"}×. ` +
        `Charging the full hedge premium to keep protection active.`;
      return cacheAndReturn({
        status: "pass_through",
        expiryTag: quote.expiryTag || "",
        targetDays: quote.targetDays || 0,
        optionType,
        strike: quote.strike.toFixed(0),
        instrument: optionInstrument,
        premiumUsdc: quote.premiumTotal.toFixed(2),
        premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
        hedgeSize: hedgeSizeForQuote.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: bufferTargetPctCapped.toFixed(4),
        markIv: feeIv.raw,
        feeUsdc: passThroughFee.toFixed(2),
        subsidyUsdc: "0.00",
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
        passThroughCapped: true,
        liquidityOverride: liquidityOverrideUsed,
        replication: replicationMeta,
        survivalCheck: buildSurvivalCheck({
          spotPrice,
          drawdownFloorPct,
          optionType,
          strike: quote.strike,
          hedgeSize: hedgeSizeForQuote,
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
        pricing: {
          type: "pass_through_override",
          baseFee: baseFeeUsdc.toFixed(2),
          hedgePremium: allInPremium.toFixed(2),
          totalFee: passThroughFee.toFixed(2),
          markupPct: markupPct.mul(100).toFixed(2),
          markupUsdc: passThroughFee.minus(allInPremium).toFixed(2),
          ratio: premiumFloor.ratio.toFixed(4),
          threshold: premiumFloor.threshold.toFixed(4),
          capMultiplier: passThroughCapInfo.capMultiplier
            ? formatCapMultiplier(passThroughCapInfo, 2)
            : "N/A",
          explanation
        },
        warning: {
          type: "premium_pass_through_override",
          ratio: premiumFloor.ratio.toFixed(4),
          threshold: premiumFloor.threshold.toFixed(4),
          message: explanation
        },
        reason: "premium_floor_pass_through_override",
        debugPassThrough: passThroughDebug
      });
    }
    const subsidyNeededFull = allInPremium.minus(cappedFee);
    if (isPremiumTier) {
      const venueInfo = attachVenueMetadata({
        selectionSnapshot: bestSnapshots
          ? {
              expiryTag: quote.expiryTag,
              targetDays: quote.targetDays,
              strike: quote.strike.toFixed(0),
              books: bestSnapshots
            }
          : null,
        hedgeSize: hedgeSizeForQuote.toFixed(4)
      } as Record<string, unknown>);
      await audit("premium_pass_through", {
        type: "capped_with_subsidy",
        baseFee: feeBase.feeUsdc.toFixed(2),
        allInPremium: allInPremium.toFixed(2),
        cappedFee: cappedFee.toFixed(2),
        platformSubsidy: subsidyNeededFull.toFixed(2),
        capMultiplier: passThroughCapInfo.capMultiplier
          ? formatCapMultiplier(passThroughCapInfo, 2)
          : null,
        ratio: premiumFloor.ratio.toFixed(4),
        tierName,
        leverage,
        optionType,
        instrument: optionInstrument,
        hedgeSize: hedgeSizeForQuote.toFixed(4),
        fullProtection: true,
        optionVenue: (venueInfo as any).optionVenue ?? null,
        venueSavingsUsdc: (venueInfo as any).venueComparison?.savingsUsdc ?? "0.00"
      });
      return cacheAndReturn({
        status: "pass_through_capped",
        optionType,
        venue: "deribit",
        strike: quote.strike.toFixed(0),
        premiumUsdc: quote.premiumTotal.toFixed(2),
        premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
        hedgeSize: hedgeSizeForQuote.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: "0.00",
        markIv: feeIv.raw,
        expiryTag: quote.expiryTag || "",
        targetDays: quote.targetDays || 0,
        instrument: optionInstrument,
        feeUsdc: cappedFee.toFixed(2),
        subsidyUsdc: subsidyNeededFull.toFixed(2),
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
        passThroughCapped: true,
        reason: "pass_through_capped_subsidized",
        liquidityOverride: liquidityOverrideUsed,
        replication: replicationMeta,
        survivalCheck: buildSurvivalCheck({
          spotPrice,
          drawdownFloorPct,
          optionType,
          strike: quote.strike,
          hedgeSize: hedgeSizeForQuote,
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
        coveragePct: "100.00",
        feeDiscountPct: (riskControls.partial_coverage_discount_pct ?? 0) * 100,
        pricing: {
          baseFee: feeBase.feeUsdc.toFixed(2),
          hedgePremium: allInPremium.toFixed(2),
          cappedFee: cappedFee.toFixed(2),
          capMultiplier: passThroughCapInfo.capMultiplier
            ? formatCapMultiplier(passThroughCapInfo, 2)
            : "N/A",
          platformSubsidy: subsidyNeededFull.toFixed(2),
          ratio: premiumFloor.ratio.toFixed(4),
          threshold: premiumFloor.threshold.toFixed(4),
          explanation:
            `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds ${tierName} tier cap. ` +
            `Fee capped at $${cappedFee.toFixed(2)} ` +
            `(${formatCapMultiplier(passThroughCapInfo, 1) || "N/A"}× base). ` +
            `Platform subsidizing $${subsidyNeededFull.toFixed(2)} for full protection.`
        },
        warning: {
          type: "premium_capped_full_protection",
          ratio: premiumFloor.ratio.toFixed(4),
          capMultiplier: passThroughCapInfo.capMultiplier
            ? formatCapMultiplier(passThroughCapInfo, 2)
            : "N/A",
          message:
            `Premium exceeds tier cap. Fee capped at $${cappedFee.toFixed(2)}. ` +
            `You're fully protected (100% hedge). Platform covers excess.`
        },
        debugPassThrough: passThroughDebug
      });
    }
    if (!allowPartialCoverage) {
      await audit("premium_floor_rejected", {
        baseFee: feeBase.feeUsdc.toFixed(2),
        allInPremium: allInPremium.toFixed(2),
        ratio: premiumFloor.ratio.toFixed(4),
        threshold: premiumFloor.threshold.toFixed(4),
        reason: "premium_floor_pass_through_capped",
        canPassThrough,
        capped: true,
        capMultiplier: passThroughCapInfo.capMultiplier
          ? formatCapMultiplier(passThroughCapInfo, 2)
          : null,
        tierName,
        leverage,
        optionType,
        instrument: optionInstrument
      });
      return cacheAndReturn({
        status: "premium_floor",
        reason: "premium_floor_pass_through_capped",
        optionType,
        venue: "deribit",
        strike: quote.strike.toFixed(0),
        premiumUsdc: quote.premiumTotal.toFixed(2),
        premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
        hedgeSize: hedgeSizeForQuote.toFixed(4),
        sizingMethod: body.optionDelta ? "delta" : "notional",
        bufferTargetPct: "0.00",
        markIv: feeIv.raw,
        expiryTag: quote.expiryTag || "",
        targetDays: quote.targetDays || 0,
        instrument: optionInstrument,
        feeUsdc: cappedFee.toFixed(2),
        subsidyUsdc: "0.00",
        feeRegime: feeRegime.regime,
        feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
        feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
        passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
        passThroughCapped: true,
        liquidityOverride: liquidityOverrideUsed,
        replication: replicationMeta,
        survivalCheck: buildSurvivalCheck({
          spotPrice,
          drawdownFloorPct,
          optionType,
          strike: quote.strike,
          hedgeSize: hedgeSizeForQuote,
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
        pricing: {
          baseFee: feeBase.feeUsdc.toFixed(2),
          hedgePremium: allInPremium.toFixed(2),
          ratio: premiumFloor.ratio.toFixed(4),
          threshold: premiumFloor.threshold.toFixed(4),
          capMultiplier: passThroughCapInfo.capMultiplier
            ? formatCapMultiplier(passThroughCapInfo, 2)
            : "N/A",
          explanation:
            `Premium ${premiumFloor.ratio.toFixed(2)}× base fee exceeds Bronze tier cap ` +
            `of ${formatCapMultiplier(passThroughCapInfo, 1) || "N/A"}×. ` +
            `Reduce leverage, duration, or widen the floor to lower premium.`
        },
        warning: {
          type: "premium_floor",
          ratio: premiumFloor.ratio.toFixed(4),
          threshold: premiumFloor.threshold.toFixed(4),
          message:
            "Premium too high for Bronze tier. Reduce leverage, duration, or widen the floor."
        },
        debugPassThrough: passThroughDebug,
        suggestions: [
          `Reduce leverage from ${leverage}× to ${Math.max(1, Math.floor(leverage / 2))}×`,
          `Reduce protection duration from ${quote.targetDays || 0} days to ${Math.max(
            1,
            Math.floor((quote.targetDays || 0) / 2)
          )} days`,
          "Increase drawdown floor percentage to reduce premium",
          "Reduce position size to lower premium"
        ]
      });
    }
    feeUsdc = cappedFee;
    const bronzeFixedCapped = applyBronzeFixedFee(tierName, leverage, feeUsdc, optionType);
    feeUsdc = bronzeFixedCapped.fee;
    const subsidyNeeded = allInPremium.minus(feeUsdc);
    const subsidyCheck = canApplySubsidy(
      tierName,
      body.accountId || null,
      subsidyNeeded.toNumber(),
      feeIv.scaled
    );
    if (subsidyNeeded.gt(0)) {
      const affordableSize = feeUsdc.div(
        quote.premiumPerUnit.mul(new Decimal(quote.rollMultiplier))
      );
      const partialSize = Decimal.min(quote.availableSize, affordableSize);
      if (partialSize.greaterThanOrEqualTo(minSize)) {
        if (!allowPartialCoverage) {
          return cacheAndReturn({
            status: "premium_floor",
            reason: "partial_not_allowed",
            optionType,
            venue: "deribit",
            strike: quote.strike.toFixed(0),
            premiumUsdc: quote.premiumPerUnit.mul(partialSize).toFixed(2),
            premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
            hedgeSize: hedgeSizeForQuote.toFixed(4),
            sizingMethod: body.optionDelta ? "delta" : "notional",
            bufferTargetPct: "0.00",
            markIv: feeIv.raw,
            expiryTag: quote.expiryTag || "",
            targetDays: quote.targetDays || 0,
            instrument: optionInstrument,
            feeUsdc: feeUsdc.toFixed(2),
            subsidyUsdc: "0.00",
            feeRegime: feeRegime.regime,
            feeRegimeMultiplier: feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null,
            feeLeverageMultiplier: feeLeverage.multiplier ? feeLeverage.multiplier.toFixed(4) : null,
            passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
            passThroughCapped: true,
            liquidityOverride: liquidityOverrideUsed,
            replication: replicationMeta,
            survivalCheck: buildSurvivalCheck({
              spotPrice,
              drawdownFloorPct,
              optionType,
              strike: quote.strike,
              hedgeSize: hedgeSizeForQuote,
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
            pricing: {
              baseFee: feeBase.feeUsdc.toFixed(2),
              hedgePremium: allInPremium.toFixed(2),
              ratio: premiumFloor.ratio.toFixed(4),
              threshold: premiumFloor.threshold.toFixed(4),
              capMultiplier: passThroughCapInfo.capMultiplier
                ? formatCapMultiplier(passThroughCapInfo, 2)
                : "N/A",
              explanation:
                "Partial coverage not allowed for this tier. Reduce leverage or duration to lower premium."
            },
            warning: {
              type: "premium_floor",
              ratio: premiumFloor.ratio.toFixed(4),
              threshold: premiumFloor.threshold.toFixed(4),
              message: "Partial coverage not allowed for this tier."
            }
          });
        }
        const coverageRatio = partialSize.div(requiredSize);
        const discountedFee = applyPartialDiscount(feeUsdc, coverageRatio);
        return cacheAndReturn({
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
          passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
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
        });
      }
      if (subsidyNeeded.gt(0) && subsidyCheck.allowed && canFullyCoverQuote) {
        return cacheAndReturn({
          status: "subsidized",
          optionType,
          venue: "deribit",
          strike: quote.strike.toFixed(0),
          premiumUsdc: quote.premiumTotal.toFixed(2),
          premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
          hedgeSize: hedgeSizeForQuote.toFixed(4),
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
          passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
          passThroughCapped: true,
          reason: "pass_through_capped_subsidized",
          liquidityOverride: liquidityOverrideUsed,
          replication: replicationMeta,
          survivalCheck: buildSurvivalCheck({
            spotPrice,
            drawdownFloorPct,
            optionType,
            strike: quote.strike,
            hedgeSize: hedgeSizeForQuote,
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
        });
      }
      if (subsidyNeeded.gt(0) && canFullyCoverQuote && canCoverageOverride(tierName)) {
        return cacheAndReturn({
          status: "subsidized",
          optionType,
          venue: "deribit",
          strike: quote.strike.toFixed(0),
          premiumUsdc: quote.premiumTotal.toFixed(2),
          premiumPerUnitUsdc: quote.premiumPerUnit.toFixed(2),
          hedgeSize: hedgeSizeForQuote.toFixed(4),
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
          passThroughCapMultiplier: formatCapMultiplier(passThroughCapInfo),
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
            hedgeSize: hedgeSizeForQuote,
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
        });
      }
      return cacheAndReturn({
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
      });
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
  const allowHedgeReduction = riskControls.enable_hedge_reduction === true;
  hedgeFactor = allowHedgeReduction ? Math.min(1, hedgeFactor) : Math.max(1, hedgeFactor);

  const optionSymbol = optionType === "put" ? "P" : "C";
  const optionInstrument = buildVenueInstrumentName(
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
    coverageLegs: bestPlanLegs ?? null,
    hedgeSize: (() => {
      const adjusted = hedgeSizeForQuote.mul(hedgeFactor);
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
  response["baseFeeUsdc"] = feeBase.feeUsdc.toFixed(2);
  response["feeUsdc"] = feeUsdc.toFixed(2);
  response["premiumMarkupPct"] = markupPct.mul(100).toFixed(2);
  response["premiumMarkupUsdc"] = passThroughFee.minus(allInPremium).toFixed(2);
  response["feeRegime"] = feeRegime.regime;
  response["feeRegimeMultiplier"] = feeRegime.multiplier ? feeRegime.multiplier.toFixed(4) : null;
  response["feeLeverageMultiplier"] = feeLeverage.multiplier
    ? feeLeverage.multiplier.toFixed(4)
    : null;
  response["passThroughCapMultiplier"] = formatCapMultiplier(passThroughCapInfo);
  response["passThroughCapped"] = passThroughCapped;
  response["subsidyUsdc"] = "0.00";
  response["reason"] = feeReason;
  const minNotificationRatio = new Decimal(
    riskControls.pass_through_min_notification_ratio ?? 1.5
  );
  const shouldNotify = premiumFloor.ratio.gte(minNotificationRatio);
  if (premiumFloor.breached) {
    if (canPassThrough && !passThroughCapped) {
      response["status"] = "pass_through";
      response["feeUsdc"] = passThroughFee.toFixed(2);
      response["reason"] = "premium_floor_pass_through";
      response["pricing"] = {
        type: "pass_through",
        baseFee: feeBase.feeUsdc.toFixed(2),
        hedgePremium: allInPremium.toFixed(2),
        totalFee: passThroughFee.toFixed(2),
        markupPct: markupPct.mul(100).toFixed(2),
        markupUsdc: passThroughFee.minus(allInPremium).toFixed(2),
        ratio: premiumFloor.ratio.toFixed(4),
        threshold: premiumFloor.threshold.toFixed(4)
      };
      response["warning"] = shouldNotify
        ? {
            type: "premium_pass_through",
            ratio: premiumFloor.ratio.toFixed(4),
            threshold: premiumFloor.threshold.toFixed(4)
          }
        : undefined;
    } else if (canPassThrough && passThroughCapped && passThroughCapInfo.maxFee) {
      response["status"] = "pass_through_capped";
      response["feeUsdc"] = passThroughCapInfo.maxFee.toFixed(2);
      response["reason"] = "premium_floor_pass_through_capped";
      response["pricing"] = {
        type: "pass_through_capped",
        baseFee: feeBase.feeUsdc.toFixed(2),
        hedgePremium: allInPremium.toFixed(2),
        cappedFee: passThroughCapInfo.maxFee.toFixed(2),
        capMultiplier: passThroughCapInfo.capMultiplier
          ? formatCapMultiplier(passThroughCapInfo, 2)
          : null,
        markupPct: markupPct.mul(100).toFixed(2),
        ratio: premiumFloor.ratio.toFixed(4),
        threshold: premiumFloor.threshold.toFixed(4)
      };
      response["warning"] = shouldNotify
        ? {
            type: "premium_capped",
            ratio: premiumFloor.ratio.toFixed(4),
            threshold: premiumFloor.threshold.toFixed(4)
          }
        : undefined;
    } else {
      response["status"] = "premium_floor";
      response["reason"] = passThroughCapped
        ? "premium_floor_pass_through_capped"
        : "premium_floor";
      response["warning"] = {
        type: "premium_floor",
        ratio: premiumFloor.ratio.toFixed(4),
        threshold: premiumFloor.threshold.toFixed(4)
      };
    }
  }
  await audit("put_quote", response);
  return cacheAndReturn(response);
});

function buildInstrumentName(currency: string, expiryTag: string, strike: string, type: "P" | "C"): string {
  return `${currency}-${expiryTag}-${strike}-${type}`;
}

function buildVenueInstrumentName(
  currency: string,
  expiryTag: string,
  strike: string,
  type: "P" | "C"
): string {
  if (venueConfig.mode === "bybit_only") {
    const expiryDate = parseExpiryTagToDate(expiryTag);
    if (expiryDate) {
      return formatBybitInstrument(currency, expiryDate, Number(strike), type);
    }
  }
  return buildInstrumentName(currency, expiryTag, strike, type);
}

function deriveExpiryTag(instrumentName: string): string {
  const parts = instrumentName.split("-");
  return parts.length >= 2 ? parts[1] : "";
}

function parseExpiryTagToDate(expiryTag: string): Date | null {
  const match = expiryTag.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const monthToken = match[2];
  const year = 2000 + Number(match[3]);
  const months: Record<string, number> = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11
  };
  const month = months[monthToken];
  if (month === undefined || !Number.isFinite(day) || day <= 0) return null;
  return new Date(Date.UTC(year, month, day, 8, 0, 0, 0));
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
    autoRenew?: boolean;
  };

  if (body.autoRenew === false) {
    const response = { status: "disabled", reason: "auto_renew_off" };
    await audit("put_renew_skipped", {
      coverageId: body.coverageId ?? null,
      reason: "auto_renew_off"
    });
    return response;
  }

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
  const minSize = new Decimal(riskControls.min_option_size ?? 0.01);
  const requestedSize = new Decimal(body.amount ?? 0);
  const ledgerCoverage = body.coverageId ? coverageLedger.get(body.coverageId) : null;
  const ledgerRequiredSize = ledgerCoverage?.positions?.length
    ? ledgerCoverage.positions.reduce((acc, pos) => {
        const notional = new Decimal(pos.marginUsd || 0).mul(new Decimal(pos.leverage || 1));
        const sizeUnits = pos.entryPrice ? notional.div(new Decimal(pos.entryPrice)) : new Decimal(0);
        return acc.add(sizeUnits);
      }, new Decimal(0))
    : null;
  const baseRequiredSize = Decimal.max(minSize, ledgerRequiredSize ?? requestedSize);
  const requiredSize = baseRequiredSize;
  let hedgeSizeForRenew = requiredSize;
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
    hedgeSize: Decimal;
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
        let quotes = await getOptionVenueQuotes(inst.instrument_name, spotPrice);
        if (!quotes.length) continue;
        const strike = new Decimal(inst.strike);
        const coverageSize = requiredHedgeSizeForFullCoverage({
          spotPrice,
          drawdownFloorPct,
          optionType,
          strike,
          requiredSize
        });
        if (!coverageSize) continue;
        const targetSize = Decimal.max(minSize, coverageSize);
        let agg = aggregateOptionQuotes(quotes, "buy", targetSize);
        if (
          venueConfig.mode === "bybit_only" &&
          agg.filledSize.lt(targetSize) &&
          venueConfig.deribit_enabled
        ) {
          const deribitQuote = await fetchDeribitQuoteForInstrument(inst.instrument_name, spotPrice);
          if (deribitQuote) {
            quotes = [...quotes, deribitQuote];
            agg = aggregateOptionQuotes(quotes, "buy", targetSize);
          }
        }
        if (!agg.bestBid || !agg.bestAsk) continue;
        if (agg.spread.gt(maxSpreadPct)) continue;
        if (!agg.avgPrice || agg.filledSize.lte(0) || agg.filledSize.lt(targetSize)) continue;
        const slippagePct = agg.avgPrice.minus(agg.bestAsk).div(agg.bestAsk);
        if (slippagePct.gt(maxSlippagePct)) continue;
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
        snapshotsByStrike.set(strike.toFixed(0), snapshots);

        const ticker = await deribit.getTicker(inst.instrument_name);
        const iv = Number((ticker as any)?.result?.mark_iv ?? 0);
        const premiumPerUnit = agg.avgPrice;
        const premiumTotal = premiumPerUnit.mul(targetSize);
        const rollMultiplier = Math.max(1, Math.ceil(targetDays / days));
        const allInPremium = premiumTotal.mul(new Decimal(rollMultiplier));
        if (!bestCandidate || allInPremium.lt(bestCandidate.allInPremium)) {
          bestCandidate = {
            expiryTag,
            targetDays: days,
            premiumPerUnit,
            premiumTotal,
            availableSize: agg.totalAskSize,
            strike,
            iv,
            spreadPct: agg.spread,
            rollMultiplier,
            allInPremium,
            hedgeSize: targetSize
          };
          bestSnapshots = snapshots;
          chosenExecutionPlans = agg.plans;
          chosenSnapshots = snapshotsByStrike;
        }
        plansByStrike.set(strike.toFixed(0), agg.plans);
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
  let effectiveSize = hedgeSizeForRenew;
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
        hedgeSize: hedgeSizeForRenew,
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
    ivCandidate: quote?.iv,
    optionType
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
    leverage: renewLeverage,
    optionType
  });
  if (renewSafety.feeUsdc && renewSafety.feeUsdc.gt(effectiveFeeUsdc)) {
    effectiveFeeUsdc = renewSafety.feeUsdc;
    renewReason = "ctc_safety";
  }
  const renewBaseFeeUsdc = effectiveFeeUsdc;
  const renewPremiumFloor = premiumFloorBreached(effectiveAllInPremium, renewBaseFeeUsdc);
  const renewMarkupPct = resolvePremiumMarkupPct(tierName, renewLeverage);
  const renewPassThroughFee = effectiveAllInPremium.mul(new Decimal(1).add(renewMarkupPct));
  const renewPassThroughEnabled = riskControls.enable_premium_pass_through !== false;
  const renewRequiresUserOptIn = riskControls.require_user_opt_in_for_pass_through === true;
  const renewUserOptedIn = body.allowPremiumPassThrough !== false;
  const renewCanPassThrough =
    renewPassThroughEnabled && (!renewRequiresUserOptIn || renewUserOptedIn);
  if (!renewPremiumFloor.breached) {
    if (renewPassThroughFee.gt(renewBaseFeeUsdc)) {
      effectiveFeeUsdc = renewPassThroughFee;
      renewReason = "premium_markup";
    } else {
      effectiveFeeUsdc = renewBaseFeeUsdc;
      if (renewReason !== "ctc_safety") {
        renewReason = "base_fee";
      }
    }
  }
  let subsidyNeeded = effectiveAllInPremium.minus(effectiveFeeUsdc);
  let subsidyCheck = canApplySubsidy(
    tierName,
    body.accountId || null,
    subsidyNeeded.toNumber(),
    effectiveIv
  );
  const renewPassThroughCap = applyPassThroughCap(
    renewBaseFeeUsdc,
    effectiveAllInPremium,
    renewLeverage,
    tierName,
    effectiveIv ?? 0
  );
  const renewPassThroughCapped = renewPassThroughCap.maxFee
    ? renewPassThroughFee.gt(renewPassThroughCap.maxFee)
    : false;
  await audit("pass_through_gate", {
    passThroughEnabled: renewPassThroughEnabled,
    requiresUserOptIn: renewRequiresUserOptIn,
    userOptedIn: renewUserOptedIn,
    canPassThrough: renewCanPassThrough,
    tierName,
    leverage: renewLeverage,
    premiumRatio: renewPremiumFloor.ratio.toFixed(4)
  });
  const canFullyCover = effectiveAvailableSize
    ? effectiveAvailableSize.greaterThanOrEqualTo(effectiveSize)
    : false;
  if (renewPremiumFloor.breached && renewReason !== "pass_through") {
    if (renewCanPassThrough && !renewPassThroughCapped) {
      renewReason = "pass_through";
      effectiveFeeUsdc = renewPassThroughFee;
    } else if (renewCanPassThrough && renewPassThroughCapped && renewPassThroughCap.maxFee) {
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
        reason: renewPassThroughCapped
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
        passThroughCapMultiplier: formatCapMultiplier(renewPassThroughCap),
        passThroughCapped: renewPassThroughCapped,
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
          renewBaseFeeUsdc,
          effectiveAllInPremium,
          renewLeverage,
          tierName,
          effectiveIv ?? 0
        );
        const latePassThroughFee = effectiveAllInPremium.mul(new Decimal(1).add(renewMarkupPct));
        const lateCapped = lateCap.maxFee ? latePassThroughFee.gt(lateCap.maxFee) : false;
        if (!lateCapped) {
          renewReason = "pass_through";
          effectiveFeeUsdc = latePassThroughFee;
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
  const plannedInstrument = chosenExecutionPlans?.[0]?.instrument;
  const optionInstrument =
    plannedInstrument ??
    buildVenueInstrumentName(
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
  const renewVenue =
    chosenExecutionPlans?.[0]?.venue ?? (venueConfig.mode === "bybit_only" ? "bybit" : "deribit");
  const renewInstrument =
    renewVenue === "bybit" && !optionInstrument.endsWith("-USDT")
      ? `${optionInstrument}-USDT`
      : optionInstrument;
  const buyOption = await executionRegistry.placeOrder(renewVenue, {
    instrument: renewInstrument,
    amount: cappedAmount.toNumber(),
    side: "buy",
    type: "market",
    spotPrice: body.spotPrice
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
    venue: renewVenue,
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
    passThroughCapMultiplier: formatCapMultiplier(renewPassThroughCap),
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
  const renewPremiumValueRaw = renewPremiumUsdc ?? effectivePremiumUsdc.toFixed(2);
  const renewPremiumValue = Number(renewPremiumValueRaw);
  const renewCashflowUsdc = Number.isFinite(renewPremiumValue) ? renewPremiumValue : null;
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
    cashflowUsdc: renewCashflowUsdc,
    feeUsdc,
    subsidyUsdc: subsidyUsdc.toFixed(2),
    reason: renewReason,
    venue: renewVenue
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
  const renewExecuted =
    renewStatus === "paper_filled" || renewStatus === "filled" || renewStatus === "ok";
  const expiryDate = effectiveExpiryTag ? parseExpiryTagToDate(effectiveExpiryTag) : null;
  const renewalExpiryIso = expiryDate ? expiryDate.toISOString() : body.expiryIso || "";
  if (body.coverageId && renewExecuted) {
    upsertCoverageLedger({
      coverageId: body.coverageId,
      expiryIso: renewalExpiryIso,
      hedgeInstrument: renewInstrument,
      hedgeSize: cappedAmount.toNumber(),
      hedgeType: "option",
      optionType,
      strike: effectiveStrike ? Number(effectiveStrike.toFixed(0)) : null,
      selectedVenue: renewVenue,
      markSource: renewVenue === "bybit" || renewVenue === "deribit" ? renewVenue : null,
      autoRenew: true,
      status: "active"
    });
    await saveCoverageLedger();
  }
  await audit("coverage_renewed", {
    tier: tierName,
    expiryIso: renewalExpiryIso || body.expiryIso,
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
    selectedVenue?: string;
    autoRenew?: boolean;
    assets?: string[];
    spotByAsset?: Record<string, number>;
    exposures?: Array<{
      asset: string;
      side: "long" | "short";
      entryPrice: number;
      size: number;
      leverage: number;
    }>;
    skipNetExposure?: boolean;
    positionSide?: "long" | "short";
    optionType?: "put" | "call";
  };

  Object.assign(riskControls, await loadRiskControls(RISK_CONTROLS_PATH));

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

  const coverage = body.coverageId ? activeCoverages.get(body.coverageId) : null;
  if (body.coverageId && typeof body.autoRenew === "boolean") {
    const existing = coverageLedger.get(body.coverageId);
    if (!existing || existing.autoRenew !== body.autoRenew) {
      upsertCoverageLedger({ coverageId: body.coverageId, autoRenew: body.autoRenew });
      await saveCoverageLedger();
    }
  }
  const inferredPositionSide =
    body.positionSide || (coverage?.positions?.[0]?.side as "long" | "short" | undefined) || "long";
  const inferredOptionType = body.optionType || (inferredPositionSide === "short" ? "call" : "put");
  const inferredHedgeType = body.hedgeType || "option";

  const baseBufferPct = new Decimal(riskPayload.drawdownBufferPct).div(100);
  let bufferPct = baseBufferPct;
  let bufferSource: "risk_summary" | "coverage_ledger" | "mtm_snapshot" | "mtm_stale" | "mtm_invalid" =
    "risk_summary";
  let mtmAgeMs: number | null = null;
  const useMtmBuffer = riskControls.loop_use_mtm_buffer === true;
  const maxAgeMs = riskControls.loop_mtm_max_age_ms ?? 0;
  if (useMtmBuffer && body.coverageId) {
    const ledgerEntry = coverageLedger.get(body.coverageId);
    const ledgerBuffer = ledgerEntry?.lastMtm?.bufferUsdc;
    const ledgerTs = ledgerEntry?.lastMtm?.ts;
    const initialBalance = new Decimal(body.initialBalanceUsdc || "0");
    if (ledgerTs) {
      const ledgerAge = Date.now() - Date.parse(ledgerTs);
      if (Number.isFinite(ledgerAge)) {
        mtmAgeMs = ledgerAge;
      }
    }
    if (ledgerBuffer !== undefined && ledgerBuffer !== null && initialBalance.gt(0)) {
      if (maxAgeMs > 0 && mtmAgeMs !== null && mtmAgeMs > maxAgeMs) {
        bufferSource = "mtm_stale";
      } else {
        bufferPct = new Decimal(ledgerBuffer).div(initialBalance);
        bufferSource = "coverage_ledger";
      }
    }
  }
  if (useMtmBuffer && bufferSource === "risk_summary" && lastMtmSnapshot) {
    const ageMs = Date.now() - lastMtmSnapshotAt;
    if (Number.isFinite(ageMs)) {
      mtmAgeMs = ageMs;
    }
    if (maxAgeMs <= 0 || ageMs <= maxAgeMs) {
      const drawdownLimit = new Decimal(body.drawdownLimitUsdc || "0");
      const initialBalance = new Decimal(body.initialBalanceUsdc || "0");
      if (initialBalance.gt(0)) {
        bufferPct = lastMtmSnapshot.equityUsdc.minus(drawdownLimit).div(initialBalance);
        bufferSource = "mtm_snapshot";
      } else {
        bufferSource = "mtm_invalid";
      }
    } else {
      bufferSource = "mtm_stale";
    }
  }
  if (
    useMtmBuffer &&
    bufferSource === "risk_summary" &&
    (mtmAgeMs !== null || lastMtmSnapshot)
  ) {
    bufferSource = "mtm_invalid";
  }
  let decision = evaluateRollingHedge({
    bufferPct,
    hedgeState: {
      bufferTargetPct: new Decimal(body.bufferTargetPct),
      hysteresisPct: new Decimal(body.hysteresisPct)
    },
    expiryIso: body.expiryIso,
    renewWindowMinutes: body.renewWindowMinutes,
    positionSide: inferredPositionSide,
    currentOptionType: inferredOptionType,
    hedgeType: inferredHedgeType
  });
  const ledgerAutoRenew = body.coverageId
    ? coverageLedger.get(body.coverageId)?.autoRenew
    : undefined;
  const autoRenewEnabled =
    body.autoRenew !== undefined ? body.autoRenew : ledgerAutoRenew ?? true;
  if (!autoRenewEnabled && decision.renew) {
    await audit("put_renew_skipped", {
      coverageId: body.coverageId ?? null,
      reason: "auto_renew_off"
    });
    decision = {
      ...decision,
      renew: false,
      reason: "auto_renew_off"
    };
  }

  const hedgeCooldownMs = riskControls.hedge_action_cooldown_ms ?? 60000;
  const estimatePremiumEnabled = riskControls.estimate_premium_on_missing === true;
  const staleMtmThresholdMs =
    riskControls.loop_stale_mtm_cooldown_ms ?? riskControls.loop_mtm_max_age_ms ?? 0;
  const blockOnStaleMtm = riskControls.loop_block_on_stale_mtm === true;
  const mtmStaleByAge =
    staleMtmThresholdMs > 0 && mtmAgeMs !== null && mtmAgeMs > staleMtmThresholdMs;
  const mtmBlocked =
    blockOnStaleMtm &&
    (bufferSource === "mtm_stale" || bufferSource === "mtm_invalid" || mtmStaleByAge);
  const minHedgeNotional = riskControls.min_hedge_notional_usdc ?? 0;
  const loopAccountingEnabled = riskControls.loop_accounting_enabled === true;
  const coverageKey = body.coverageId || body.accountId || "unknown";
  const lastHedgeAt = hedgeActionCooldownByCoverage.get(coverageKey) ?? 0;
  const withinCooldown =
    hedgeCooldownMs > 0 && Date.now() - lastHedgeAt < hedgeCooldownMs;
  const ledgerNotional =
    body.coverageId && coverageLedger.has(body.coverageId)
      ? coverageLedger.get(body.coverageId)?.notionalUsdc ?? null
      : null;
  const notionalUsdc = Number(body.notionalUsdc ?? ledgerNotional ?? 0);
  const requireNotional = riskControls.loop_require_notional_usdc === true;
  const missingNotional =
    requireNotional && (!Number.isFinite(notionalUsdc) || notionalUsdc <= 0);
  const belowNotional =
    Number.isFinite(notionalUsdc) &&
    minHedgeNotional > 0 &&
    notionalUsdc > 0 &&
    notionalUsdc < minHedgeNotional;

  const phase3RolloutEnabled = riskControls.phase3_rollout_enabled ?? false;
  const phase3SafetyGuardEnabled = riskControls.phase3_safety_guard_enabled ?? true;
  const requestedIntermittentAnalytics = riskControls.intermittent_analytics_enabled ?? false;
  const requestedSelectionShadow = riskControls.intermittent_selection_shadow_enabled ?? false;
  const requestedSelectionLive = riskControls.intermittent_selection_live_enabled ?? false;
  const requestedProfitThresholds = riskControls.intermittent_profit_threshold_enabled ?? false;
  const selectionShadowEnabled =
    phase3RolloutEnabled &&
    (requestedSelectionShadow || (phase3SafetyGuardEnabled && requestedSelectionLive));
  const selectionLiveEnabled =
    phase3RolloutEnabled && !phase3SafetyGuardEnabled && requestedSelectionLive;
  const profitThresholdsEnabled = phase3RolloutEnabled && requestedProfitThresholds;
  const profitThresholdsEnforced =
    phase3RolloutEnabled &&
    requestedProfitThresholds &&
    (!phase3SafetyGuardEnabled || riskControls.intermittent_profit_enforce_override === true);
  const intermittentConfig = {
    rolloutEnabled: phase3RolloutEnabled,
    safetyGuardEnabled: phase3SafetyGuardEnabled,
    analytics: phase3RolloutEnabled && requestedIntermittentAnalytics,
    selectionShadow: selectionShadowEnabled,
    selectionLive: selectionLiveEnabled,
    profitThresholdsEnabled,
    profitThresholdsEnforced,
    profitMinImprovementUsdc: riskControls.intermittent_profit_min_improvement_usdc ?? 0,
    profitMinImprovementRatio: riskControls.intermittent_profit_min_improvement_ratio ?? 0,
    profitCriticalBufferPct: riskControls.intermittent_profit_critical_buffer_pct ?? 0
  };

  let renewalResult: unknown = { status: autoRenewEnabled ? "skipped" : "disabled" };
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
    if (inferredHedgeType !== "option") {
      await audit("hedge_action_skipped", {
        action: "increase",
        reason: "options_only",
        coverageId: body.coverageId || null,
        notionalUsdc: notionalUsdc || null
      });
    } else if (withinCooldown || belowNotional || missingNotional || mtmBlocked) {
      await audit("hedge_action_skipped", {
        action: "increase",
        reason: withinCooldown
          ? "cooldown"
          : mtmBlocked
            ? "mtm_stale"
            : missingNotional
              ? "missing_notional"
              : "min_notional",
        coverageId: body.coverageId || null,
        notionalUsdc: notionalUsdc || null,
        cooldownMs: hedgeCooldownMs,
        bufferSource,
        mtmAgeMs: mtmAgeMs ?? null
      });
    } else {
      let executionInstrument = body.hedgeInstrument;
      const requestedHedgeSize = Number(body.hedgeSize ?? 0);
      let executionSize = requestedHedgeSize;
      const sizeTolerancePctRaw = Number(
        riskControls.intermittent_selection_size_tolerance_pct ?? 0.2
      );
      const sizeTolerancePct =
        Number.isFinite(sizeTolerancePctRaw) && sizeTolerancePctRaw >= 0
          ? sizeTolerancePctRaw
          : 0;
      let sizeSelectionApplied = false;
      let sizeDeltaPct: number | null = null;
      let selectionMode: "disabled" | "shadow" | "live" = "disabled";
      let selectionError: string | null = null;
      let candidateQuoteStatus: string | null = null;
      let expectedImprovementUsdc: number | null = null;
      let expectedCostUsdc: number | null = null;
      let candidatePlan: {
        instrument: string;
        venue: string | null;
        strike: number | null;
        hedgeSize: number | null;
        premiumPerUnitUsdc: number | null;
        premiumTotalUsdc: number | null;
        coverageRatio: number | null;
      } | null = null;
      let profitCheck = { allowed: true, reason: "disabled" };
      const shouldComputeCandidate =
        intermittentConfig.selectionShadow ||
        intermittentConfig.selectionLive ||
        intermittentConfig.profitThresholdsEnabled ||
        intermittentConfig.analytics;
      if (shouldComputeCandidate) {
        selectionMode = intermittentConfig.selectionLive
          ? "live"
          : intermittentConfig.selectionShadow
            ? "shadow"
            : "disabled";
        const ledgerEntry = body.coverageId ? coverageLedger.get(body.coverageId) : null;
        const position = ledgerEntry?.positions?.[0] ?? coverage?.positions?.[0] ?? null;
        const tierName = ledgerEntry?.tier ?? body.tierName ?? "Unknown";
        if (position) {
          const positionSize =
            position.entryPrice > 0
              ? (position.marginUsd * position.leverage) / position.entryPrice
              : 0;
          const drawdownLimitUsdc = Number(body.drawdownLimitUsdc ?? 0);
          const initialBalanceUsdc = Number(body.initialBalanceUsdc ?? 0);
          const equityUsd = Number(ledgerEntry?.equityUsd ?? 0);
          const floorUsd = Number(ledgerEntry?.floorUsd ?? 0);
          let drawdownFloorPctValue: number | null = null;
          if (equityUsd > 0 && floorUsd > 0) {
            drawdownFloorPctValue = 1 - floorUsd / equityUsd;
          } else if (initialBalanceUsdc > 0 && drawdownLimitUsdc > 0) {
            drawdownFloorPctValue = 1 - drawdownLimitUsdc / initialBalanceUsdc;
          }
          if (
            drawdownFloorPctValue !== null &&
            Number.isFinite(drawdownFloorPctValue) &&
            drawdownFloorPctValue > 0
          ) {
            const asset = position.asset || "BTC";
            let spotPriceNumber = Number(body.spotByAsset?.[asset] ?? 0);
            if (!spotPriceNumber) {
              const spot = await fetchSpotPrice(asset);
              spotPriceNumber = spot ? spot.toNumber() : 0;
            }
            if (spotPriceNumber > 0 && positionSize > 0) {
              const targetDays = (() => {
                const expiryMs = Date.parse(body.expiryIso);
                if (Number.isFinite(expiryMs)) {
                  const days = Math.ceil((expiryMs - Date.now()) / (24 * 60 * 60 * 1000));
                  return Math.max(1, days);
                }
                return riskControls.default_target_days ?? 7;
              })();
              const quoteRes = await app.inject({
                method: "POST",
                url: "/put/quote",
                payload: {
                  tierName,
                  asset,
                  spotPrice: spotPriceNumber,
                  drawdownFloorPct: drawdownFloorPctValue,
                  positionSize,
                  fixedPriceUsdc: 0,
                  contractSize: 1,
                  leverage: position.leverage,
                  side: position.side,
                  coverageId: body.coverageId ?? "intermittent",
                  targetDays,
                  allowPremiumPassThrough: true,
                  _fastPreview: true
                }
              });
              const quoteData = quoteRes.json() as Record<string, any>;
              candidateQuoteStatus = String(quoteData?.status ?? "unknown");
              if (
                candidateQuoteStatus !== "no_quote" &&
                candidateQuoteStatus !== "perp_fallback" &&
                quoteData?.instrument
              ) {
                const candidateInstrument = String(quoteData.instrument);
                const parsed = parseOptionInstrument(candidateInstrument);
                const strikeValue =
                  quoteData?.strike !== undefined && quoteData?.strike !== null
                    ? Number(quoteData.strike)
                    : parsed.strike;
                candidatePlan = {
                  instrument: candidateInstrument,
                  venue: quoteData?.optionVenue ?? quoteData?.venueSelection?.selected ?? null,
                  strike: Number.isFinite(strikeValue ?? NaN) ? (strikeValue as number) : null,
                  hedgeSize:
                    quoteData?.hedgeSize !== undefined && quoteData?.hedgeSize !== null
                      ? Number(quoteData.hedgeSize)
                      : null,
                  premiumPerUnitUsdc:
                    quoteData?.premiumPerUnitUsdc !== undefined && quoteData?.premiumPerUnitUsdc !== null
                      ? Number(quoteData.premiumPerUnitUsdc)
                      : null,
                  premiumTotalUsdc:
                    quoteData?.rollEstimatedPremiumUsdc ??
                    quoteData?.premiumUsdc ??
                    null,
                  coverageRatio:
                    quoteData?.survivalCheck?.coverageRatio !== undefined
                      ? Number(quoteData.survivalCheck.coverageRatio)
                      : null
                };
                const candidateHedgeSize =
                  candidatePlan.hedgeSize !== null && Number.isFinite(candidatePlan.hedgeSize)
                    ? candidatePlan.hedgeSize
                    : null;
                if (candidateHedgeSize && candidateHedgeSize > 0 && executionSize > 0) {
                  sizeDeltaPct = Math.abs(candidateHedgeSize - executionSize) / executionSize;
                  if (
                    intermittentConfig.selectionLive &&
                    Number.isFinite(sizeDeltaPct) &&
                    sizeDeltaPct <= sizeTolerancePct
                  ) {
                    executionSize = candidateHedgeSize;
                    sizeSelectionApplied = true;
                  }
                }
                if (candidatePlan.strike !== null) {
                  const intrinsic = computeIntrinsicAtFloor({
                    spotPrice: new Decimal(spotPriceNumber),
                    drawdownFloorPct: new Decimal(drawdownFloorPctValue),
                    optionType: inferredOptionType,
                    strike: new Decimal(candidatePlan.strike)
                  });
                  expectedImprovementUsdc = intrinsic.mul(new Decimal(executionSize)).toNumber();
                }
                if (candidatePlan.premiumPerUnitUsdc && candidatePlan.premiumPerUnitUsdc > 0) {
                  expectedCostUsdc = candidatePlan.premiumPerUnitUsdc * executionSize;
                } else if (
                  candidatePlan.premiumTotalUsdc &&
                  candidatePlan.hedgeSize &&
                  candidatePlan.hedgeSize > 0
                ) {
                  expectedCostUsdc =
                    Number(candidatePlan.premiumTotalUsdc) *
                    (executionSize / candidatePlan.hedgeSize);
                }
              }
            } else {
              selectionError = "spot_or_size_unavailable";
            }
          } else {
            selectionError = "drawdown_floor_unavailable";
          }
        } else {
          selectionError = "position_unavailable";
        }
      }
      if (intermittentConfig.profitThresholdsEnabled) {
        const critical = new Decimal(intermittentConfig.profitCriticalBufferPct || 0);
        if (critical.gt(0) && bufferPct.lte(critical)) {
          profitCheck = { allowed: true, reason: "critical_buffer" };
        } else if (expectedImprovementUsdc === null || expectedCostUsdc === null) {
          profitCheck = { allowed: true, reason: "insufficient_data" };
        } else {
          const improvement = new Decimal(expectedImprovementUsdc);
          const cost = new Decimal(expectedCostUsdc);
          const minImprovement = new Decimal(intermittentConfig.profitMinImprovementUsdc || 0);
          const minRatio = new Decimal(intermittentConfig.profitMinImprovementRatio || 0);
          if (minImprovement.gt(0) && improvement.lt(minImprovement)) {
            profitCheck = { allowed: false, reason: "min_improvement" };
          } else if (minRatio.gt(0) && improvement.lt(cost.mul(minRatio))) {
            profitCheck = { allowed: false, reason: "improvement_ratio" };
          } else {
            profitCheck = { allowed: true, reason: "ok" };
          }
        }
      }
      if (intermittentConfig.analytics) {
        await audit("intermittent_hedge_eval", {
          coverageId: body.coverageId || null,
          bufferPct: bufferPct.toFixed(4),
          bufferSource,
          mtmAgeMs: mtmAgeMs ?? null,
          bufferTargetPct: body.bufferTargetPct,
          hysteresisPct: body.hysteresisPct,
          decision: decision.hedgeAction,
          reason: decision.reason,
          phase3RolloutEnabled: intermittentConfig.rolloutEnabled,
          phase3SafetyGuardEnabled: intermittentConfig.safetyGuardEnabled,
          requestedHedgeSize: Number.isFinite(requestedHedgeSize) ? requestedHedgeSize : null,
          selectedHedgeSize: Number.isFinite(executionSize) ? executionSize : null,
          sizeDeltaPct: sizeDeltaPct !== null ? Number(sizeDeltaPct.toFixed(4)) : null,
          sizeSelectionApplied,
          selectionMode,
          selectionError,
          quoteStatus: candidateQuoteStatus,
          candidatePlan,
          expectedImprovementUsdc: expectedImprovementUsdc ?? null,
          expectedCostUsdc: expectedCostUsdc ?? null,
          profitCheck: intermittentConfig.profitThresholdsEnabled
            ? profitCheck
            : { allowed: true, reason: "disabled" }
        });
      }
      if (intermittentConfig.selectionLive && candidatePlan?.instrument) {
        executionInstrument = candidatePlan.instrument;
      }
      if (intermittentConfig.profitThresholdsEnforced && !profitCheck.allowed) {
        await audit("hedge_action_skipped", {
          action: "increase",
          reason: `profit_threshold_${profitCheck.reason}`,
          coverageId: body.coverageId || null,
          notionalUsdc: body.notionalUsdc ?? null,
          expectedImprovementUsdc: expectedImprovementUsdc ?? null,
          expectedCostUsdc: expectedCostUsdc ?? null
        });
      } else {
        await audit("hedge_action", {
          action: "increase",
          reason: decision.reason,
          instrument: executionInstrument,
          size: executionSize,
          coverageId: body.coverageId || null,
          notionalUsdc: body.notionalUsdc ?? null,
          hedgeType: inferredHedgeType,
          positionSide: inferredPositionSide,
          recommendedSide: decision.recommendedSide
        });
      const selectedVenue =
        intermittentConfig.selectionLive && candidatePlan?.venue
          ? candidatePlan.venue
          : typeof body.selectedVenue === "string"
            ? body.selectedVenue
            : null;
      const ledgerVenue = body.coverageId
        ? coverageLedger.get(body.coverageId)?.selectedVenue
        : null;
      const inferredVenue = inferVenueFromInstrument(executionInstrument);
      const hedgeVenue =
        selectedVenue ||
        ledgerVenue ||
        inferredVenue ||
        (venueConfig.mode === "bybit_only" ? "bybit" : "deribit");
      const hedgeInstrument =
        hedgeVenue === "bybit" &&
        typeof executionInstrument === "string" &&
        !executionInstrument.endsWith("-USDT")
          ? `${executionInstrument}-USDT`
          : executionInstrument;
      const inferredAsset = parseInstrumentAsset(hedgeInstrument) || "BTC";
      const orderResult = await executionRegistry.placeOrder(hedgeVenue, {
        instrument: hedgeInstrument,
        amount: executionSize,
        side: decision.recommendedSide,
        type: "market",
        spotPrice: body.spotPrice
      });
      let executedSize = Number(executionSize ?? 0);
      const orderStatus = String((orderResult as any)?.status || "");
      let fillPriceUsdc: Decimal | null = null;
      let executedPremiumUsdc: number | null = null;
      if (orderResult && typeof orderResult === "object") {
        const filled =
          (orderResult as any).filledAmount ??
          (orderResult as any).result?.filledAmount ??
          (orderResult as any).filled_amount;
        if (Number.isFinite(filled)) {
          executedSize = Number(filled);
        }
      }
      const fillPrice =
        (orderResult as any)?.result?.average_price ??
        (orderResult as any)?.result?.price ??
        (orderResult as any)?.fillPrice ??
        null;
      const executed =
        orderStatus === "paper_filled" || orderStatus === "filled" || orderStatus === "ok";
      if (executed && fillPrice && executedSize > 0) {
        const isBybitExec = hedgeVenue === "bybit";
        let spotPriceNumber = Number(body.spotByAsset?.[inferredAsset] ?? body.spotPrice ?? 0);
        if (!spotPriceNumber && !isBybitExec) {
          const spot = await fetchSpotPrice(inferredAsset);
          spotPriceNumber = spot ? spot.toNumber() : 0;
        }
        fillPriceUsdc =
          inferredHedgeType === "option"
            ? isBybitExec
              ? new Decimal(fillPrice)
              : spotPriceNumber
                ? new Decimal(fillPrice).mul(new Decimal(spotPriceNumber))
                : null
            : new Decimal(fillPrice);
        if (fillPriceUsdc) {
          executedPremiumUsdc = fillPriceUsdc.mul(new Decimal(executedSize)).toNumber();
          const sizeDelta = new Decimal(executedSize).mul(
            decision.recommendedSide === "buy" ? 1 : -1
          );
          updateHedgeLedger({
            instrument: hedgeInstrument,
            sizeDelta,
            fillPriceUsdc
          });
          await saveHedgeLedger();
        }
      }
      if (body.coverageId && typeof hedgeInstrument === "string" && executedSize > 0) {
        const existing = coverageLedger.get(body.coverageId);
        let coverageLegs = existing?.coverageLegs;
        if (
          (!coverageLegs || coverageLegs.length === 0) &&
          existing?.hedgeInstrument &&
          existing?.hedgeSize
        ) {
          const seedParsed = parseOptionInstrument(existing.hedgeInstrument);
          const seedVenue =
            existing.selectedVenue ?? inferVenueFromInstrument(existing.hedgeInstrument);
          coverageLegs = mergeCoverageLegs(coverageLegs, {
            instrument: existing.hedgeInstrument,
            size: Number(existing.hedgeSize ?? 0),
            venue: seedVenue,
            optionType: existing.optionType ?? seedParsed.optionType,
            strike: existing.strike ?? seedParsed.strike
          });
        }
        const parsed = parseOptionInstrument(hedgeInstrument);
        const legVenue = hedgeVenue ?? inferVenueFromInstrument(hedgeInstrument);
        coverageLegs = mergeCoverageLegs(coverageLegs, {
          instrument: hedgeInstrument,
          size: executedSize,
          venue: legVenue,
          optionType: parsed.optionType,
          strike: parsed.strike
        });
        upsertCoverageLedger({
          coverageId: body.coverageId,
          coverageLegs
        });
        await saveCoverageLedger();
      }
      let estimatedPremiumUsdc: number | null = null;
      if (executed && executedPremiumUsdc === null && estimatePremiumEnabled) {
        try {
          const spotPriceNumber = Number(body.spotByAsset?.[inferredAsset] ?? body.spotPrice ?? 0);
          const spot = spotPriceNumber
            ? new Decimal(spotPriceNumber)
            : await fetchSpotPrice(inferredAsset);
          const mark = await fetchCoverageOptionMarkUsdc(hedgeVenue, hedgeInstrument, spot || new Decimal(0));
          if (mark && mark.isFinite() && mark.gt(0)) {
            estimatedPremiumUsdc = mark.mul(new Decimal(executedSize)).toNumber();
          }
        } catch {
          estimatedPremiumUsdc = null;
        }
      }
      const loopPremiumForAudit = executedPremiumUsdc ?? estimatedPremiumUsdc;
      const loopCashflowUsdc =
        loopPremiumForAudit !== null && loopPremiumForAudit !== undefined
          ? decision.recommendedSide === "sell"
            ? -Number(loopPremiumForAudit)
            : Number(loopPremiumForAudit)
          : null;
      await audit("hedge_order", {
        instrument: executionInstrument,
        side: decision.recommendedSide,
        amount: executedSize || executionSize,
        type: "market",
        coverageId: body.coverageId || null,
        notionalUsdc: body.notionalUsdc ?? null,
        hedgeType: inferredHedgeType,
        positionSide: inferredPositionSide,
        premiumUsdc: executedPremiumUsdc ?? null,
        estimatedPremiumUsdc,
        cashflowUsdc: loopCashflowUsdc,
        fillPrice: fillPrice ?? null,
        venue: hedgeVenue
      });
      const loopPremiumForAccounting =
        executedPremiumUsdc !== null ? executedPremiumUsdc : estimatedPremiumUsdc;
      if (executed && loopAccountingEnabled && body.tierName && loopPremiumForAccounting !== null) {
        const accounting = applyRiskAccounting(
          body.tierName,
          0,
          Number(loopPremiumForAccounting),
          Number(notionalUsdc)
        );
        await audit("liquidity_update", {
          coverageId: body.coverageId || null,
          tier: body.tierName,
          feeUsdc: 0,
          premiumUsdc: Number(loopPremiumForAccounting),
          notionalUsdc,
          delta: accounting.liquidityDelta,
          totals: liquiditySummary(),
          reason: "loop_tick"
        });
      }
      hedgeActionCooldownByCoverage.set(coverageKey, Date.now());
      }
    }
  } else if (decision.hedgeAction === "decrease") {
    if (riskControls.loop_enable_decrease !== true) {
      await audit("hedge_action_skipped", {
        action: "decrease",
        reason: "decrease_disabled",
        coverageId: body.coverageId || null,
        notionalUsdc: notionalUsdc || null
      });
    } else if (inferredHedgeType !== "option") {
      await audit("hedge_action_skipped", {
        action: "decrease",
        reason: "options_only",
        coverageId: body.coverageId || null,
        notionalUsdc: notionalUsdc || null
      });
    } else if (withinCooldown || belowNotional || missingNotional) {
      await audit("hedge_action_skipped", {
        action: "decrease",
        reason: withinCooldown ? "cooldown" : missingNotional ? "missing_notional" : "min_notional",
        coverageId: body.coverageId || null,
        notionalUsdc: notionalUsdc || null,
        cooldownMs: hedgeCooldownMs
      });
    } else {
      const executionInstrument = body.hedgeInstrument;
      const requestedHedgeSize = Number(body.hedgeSize ?? 0);
      const ledgerEntry = executionInstrument ? hedgeLedger.get(executionInstrument) : null;
      const currentSize = ledgerEntry?.size ?? new Decimal(0);
      const availableSize = currentSize.abs();
      const reduceSize =
        Number.isFinite(requestedHedgeSize) && requestedHedgeSize > 0
          ? Decimal.min(availableSize, new Decimal(requestedHedgeSize)).toNumber()
          : 0;
      if (!executionInstrument || reduceSize <= 0) {
        await audit("hedge_action_skipped", {
          action: "decrease",
          reason: "no_position_to_reduce",
          coverageId: body.coverageId || null,
          notionalUsdc: notionalUsdc || null
        });
      } else {
        const closeSide = currentSize.gt(0) ? "sell" : "buy";
        const selectedVenue =
          typeof body.selectedVenue === "string"
            ? body.selectedVenue
            : body.coverageId
              ? coverageLedger.get(body.coverageId)?.selectedVenue
              : null;
        const inferredVenue = inferVenueFromInstrument(executionInstrument);
        const hedgeVenue =
          selectedVenue ||
          inferredVenue ||
          (venueConfig.mode === "bybit_only" ? "bybit" : "deribit");
        const hedgeInstrument =
          hedgeVenue === "bybit" &&
          typeof executionInstrument === "string" &&
          !executionInstrument.endsWith("-USDT")
            ? `${executionInstrument}-USDT`
            : executionInstrument;
        const inferredAsset = parseInstrumentAsset(hedgeInstrument) || "BTC";
        await audit("hedge_action", {
          action: "decrease",
          reason: decision.reason,
          instrument: executionInstrument,
          size: reduceSize,
          coverageId: body.coverageId || null,
          notionalUsdc: body.notionalUsdc ?? null,
          hedgeType: inferredHedgeType,
          positionSide: inferredPositionSide,
          recommendedSide: closeSide
        });
        const orderResult = await executionRegistry.placeOrder(hedgeVenue, {
          instrument: hedgeInstrument,
          amount: reduceSize,
          side: closeSide,
          type: "market",
          spotPrice: body.spotPrice
        });
        let executedSize = Number(reduceSize ?? 0);
        const orderStatus = String((orderResult as any)?.status || "");
        let fillPriceUsdc: Decimal | null = null;
        let executedPremiumUsdc: number | null = null;
        if (orderResult && typeof orderResult === "object") {
          const filled =
            (orderResult as any).filledAmount ??
            (orderResult as any).result?.filledAmount ??
            (orderResult as any).filled_amount;
          if (Number.isFinite(filled)) {
            executedSize = Number(filled);
          }
        }
        const fillPrice =
          (orderResult as any)?.result?.average_price ??
          (orderResult as any)?.result?.price ??
          (orderResult as any)?.fillPrice ??
          null;
        const executed =
          orderStatus === "paper_filled" || orderStatus === "filled" || orderStatus === "ok";
        if (executed && fillPrice && executedSize > 0) {
          const isBybitExec = hedgeVenue === "bybit";
          let spotPriceNumber = Number(body.spotByAsset?.[inferredAsset] ?? body.spotPrice ?? 0);
          if (!spotPriceNumber && !isBybitExec) {
            const spot = await fetchSpotPrice(inferredAsset);
            spotPriceNumber = spot ? spot.toNumber() : 0;
          }
          fillPriceUsdc =
            inferredHedgeType === "option"
              ? isBybitExec
                ? new Decimal(fillPrice)
                : spotPriceNumber
                  ? new Decimal(fillPrice).mul(new Decimal(spotPriceNumber))
                  : null
              : new Decimal(fillPrice);
          if (fillPriceUsdc) {
            executedPremiumUsdc = fillPriceUsdc.mul(new Decimal(executedSize)).toNumber();
            const sizeDelta = new Decimal(executedSize).mul(closeSide === "buy" ? 1 : -1);
            updateHedgeLedger({
              instrument: hedgeInstrument,
              sizeDelta,
              fillPriceUsdc
            });
            await saveHedgeLedger();
            if (body.coverageId && typeof hedgeInstrument === "string") {
              const parsed = parseOptionInstrument(hedgeInstrument);
              const legVenue = hedgeVenue ?? inferVenueFromInstrument(hedgeInstrument);
              const sizeDeltaValue = sizeDelta.toNumber();
              const existing = coverageLedger.get(body.coverageId);
              const coverageLegs = mergeCoverageLegs(existing?.coverageLegs, {
                instrument: hedgeInstrument,
                size: sizeDeltaValue,
                venue: legVenue,
                optionType: parsed.optionType,
                strike: parsed.strike
              });
              upsertCoverageLedger({
                coverageId: body.coverageId,
                coverageLegs
              });
              await saveCoverageLedger();
            }
          }
        }
        let estimatedPremiumUsdc: number | null = null;
        if (executed && executedPremiumUsdc === null && estimatePremiumEnabled) {
          try {
            const spotPriceNumber = Number(body.spotByAsset?.[inferredAsset] ?? body.spotPrice ?? 0);
            const spot = spotPriceNumber
              ? new Decimal(spotPriceNumber)
              : await fetchSpotPrice(inferredAsset);
            const mark = await fetchCoverageOptionMarkUsdc(hedgeVenue, hedgeInstrument, spot || new Decimal(0));
            if (mark && mark.isFinite() && mark.gt(0)) {
              estimatedPremiumUsdc = mark.mul(new Decimal(executedSize)).toNumber();
            }
          } catch {
            estimatedPremiumUsdc = null;
          }
        }
        const basePremiumUsdc =
          executedPremiumUsdc !== null ? executedPremiumUsdc : estimatedPremiumUsdc;
        const signedPremiumUsdc =
          basePremiumUsdc !== null && closeSide === "sell" ? -basePremiumUsdc : basePremiumUsdc;
        await audit("hedge_order", {
          instrument: executionInstrument,
          side: closeSide,
          amount: executedSize || reduceSize,
          type: "market",
          coverageId: body.coverageId || null,
          notionalUsdc: body.notionalUsdc ?? null,
          hedgeType: inferredHedgeType,
          positionSide: inferredPositionSide,
          premiumUsdc: signedPremiumUsdc ?? null,
          estimatedPremiumUsdc: estimatedPremiumUsdc ?? null,
          cashflowUsdc: signedPremiumUsdc ?? null,
          fillPrice: fillPrice ?? null,
          venue: hedgeVenue
        });
        if (executed && loopAccountingEnabled && body.tierName && signedPremiumUsdc !== null) {
          const accounting = applyRiskAccounting(
            body.tierName,
            0,
            Number(signedPremiumUsdc),
            Number(notionalUsdc)
          );
          await audit("liquidity_update", {
            coverageId: body.coverageId || null,
            tier: body.tierName,
            feeUsdc: 0,
            premiumUsdc: Number(signedPremiumUsdc),
            notionalUsdc,
            delta: accounting.liquidityDelta,
            totals: liquiditySummary(),
            reason: "loop_tick"
          });
        }
        hedgeActionCooldownByCoverage.set(coverageKey, Date.now());
      }
    }
  }

  const skipNetExposure = APP_MODE === "demo" && body.skipNetExposure === true;
  if (!skipNetExposure && baseExposures.length > 0) {
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
    const netCooldownMs = riskControls.net_exposure_cooldown_ms ?? 60000;
    const netMinNotional = riskControls.net_exposure_min_notional_usdc ?? 0;
    const netKey = `${tierName}-net-exposure`;
    const lastNetAt = netExposureCooldownByTier.get(netKey) ?? 0;
    const netWithinCooldown =
      netCooldownMs > 0 && Date.now() - lastNetAt < netCooldownMs;
    if (netWithinCooldown) {
      await audit("hedge_action_skipped", {
        action: "net_exposure",
        reason: "cooldown",
        tierName,
        cooldownMs: netCooldownMs
      });
    } else {
      let netExecuted = false;
      for (const plan of plans) {
      if (
        netMinNotional > 0 &&
        plan.targetNotional.abs().lt(new Decimal(netMinNotional))
      ) {
        continue;
      }
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
      const budgetGuardEnabled = riskControls.net_exposure_budget_guard_enabled === true;
      const minBudget = riskControls.net_exposure_min_budget_usdc ?? 0;
      if (budgetGuardEnabled && (hedgeBudgetRemaining <= 0 || hedgeBudgetRemaining < minBudget)) {
        await audit("hedge_action_skipped", {
          action: "net_exposure",
          reason: "budget_guard",
          tierName,
          hedgeBudgetRemaining,
          liquidityBudget,
          revenueBudget,
          minBudget
        });
        continue;
      }

      const maxPreferredDays = riskControls.max_target_days ?? 7;
      const maxFallbackDays = riskControls.fallback_target_days ?? 14;
      const netTargetDays = Math.min(
        maxFallbackDays,
        Math.max(1, Math.round(riskControls.default_target_days ?? 7))
      );
      const preferredDays = buildDayLadder(netTargetDays, maxPreferredDays, maxFallbackDays);
      const isNetLong = plan.targetNotional.gt(0);
      const optionType = isNetLong ? "put" : "call";
      const perpSide = isNetLong ? "sell" : "buy";
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
      const netCoverageId = riskControls.net_exposure_force_coverage_id === true
        ? `net-${plan.asset}`
        : body.coverageId || `net-${plan.asset}`;

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
            coverageIds,
            coverageId: netCoverageId
          });
          const res = await app.inject({
            method: "POST",
            url: "/deribit/order",
            payload: {
              instrument: candidate.instrument,
              amount: candidate.sizeUnits.toNumber(),
              side: "buy",
              type: "market",
              coverageId: netCoverageId,
              notionalUsdc: plan.targetNotional.abs().toNumber(),
              hedgeType: "option",
              optionType,
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
            netExecuted = true;
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
          coverageIds,
          coverageId: netCoverageId
        });
        await app.inject({
          method: "POST",
          url: "/deribit/order",
          payload: {
            instrument: optionChosen.instrument,
            amount: optionChosen.sizeUnits.toNumber(),
            side: "buy",
            type: "market",
            coverageId: netCoverageId,
            notionalUsdc: plan.targetNotional.abs().toNumber(),
            hedgeType: "option",
            optionType,
            feeUsdc: 0,
            tierName,
            premiumUsdc: optionChosen.premiumUsd.toFixed(2),
            spotPrice,
            floorPrice: strikeTarget.toNumber()
          }
        });
        netExecuted = true;
        continue;
      }

      const side = perpSide;
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
        coverageIds,
        coverageId: netCoverageId
      });
      if (riskControls.net_exposure_perp_accounting_enabled === true) {
        const res = await app.inject({
          method: "POST",
          url: "/deribit/order",
          payload: {
            instrument,
            amount: routedPlan.size.toNumber(),
            side: perpSide,
            type: "market",
            coverageId: netCoverageId,
            notionalUsdc: plan.targetNotional.abs().toNumber(),
            hedgeType: "perp",
            feeUsdc: 0,
            tierName,
            spotPrice,
            venue: routedPlan.venue
          }
        });
        const payload = res.json() as Record<string, unknown>;
        const status = String(payload?.status || "");
        netExecuted = status === "paper_filled" || status === "filled" || status === "ok";
      } else {
        await executionRegistry.placeOrder(routedPlan.venue || "deribit", {
          instrument,
          amount: routedPlan.size.toNumber(),
          side: perpSide,
          type: "market"
        });
        await audit("hedge_order", {
          instrument,
          side: perpSide,
          amount: routedPlan.size.toNumber(),
          type: "market",
          notionalUsdc: plan.targetNotional.abs().toNumber(),
          hedgeType: "perp",
          hedgeFactor: hedgeFactor.toNumber(),
          fundingRate,
          coverageIds,
          coverageId: netCoverageId,
          venue: routedPlan.venue
        });
        netExecuted = true;
      }
    }
    if (netExecuted) {
      netExposureCooldownByTier.set(netKey, Date.now());
    }
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
  const hedge = ((body as any).hedge as Record<string, unknown> | undefined) ?? {};
  const hedgeInstrument = typeof hedge.instrument === "string" ? hedge.instrument : null;
  const hedgeVenue =
    typeof (body as any).selectedVenue === "string"
      ? String((body as any).selectedVenue)
      : typeof hedge.venue === "string"
        ? String(hedge.venue)
        : inferVenueFromInstrument(hedgeInstrument);
  const hedgeSize =
    hedge.hedgeSize !== undefined && hedge.hedgeSize !== null ? Number(hedge.hedgeSize) : null;
  const hedgeType =
    typeof hedge.hedgeType === "string" ? (hedge.hedgeType as "option" | "perp") : null;
  const optionType =
    typeof hedge.optionType === "string" ? (hedge.optionType as "put" | "call") : null;
  const strikeValue =
    hedge.strike !== undefined && hedge.strike !== null ? Number(hedge.strike) : null;
  if (coverageIdValue && expiryValue && positions.length > 0) {
    activeCoverages.set(coverageIdValue, {
      coverageId: coverageIdValue,
      expiryIso: expiryValue,
      positions
    });
    await saveCoverages();
  }
  if (coverageIdValue) {
    const entry = upsertCoverageLedger({
      coverageId: coverageIdValue,
      expiryIso: expiryValue || "",
      positions,
      accountId: (body as any).accountId ?? null,
      tier: tierName,
      autoRenew: (body as any).autoRenew ?? undefined,
      selectedVenue: hedgeVenue,
      hedgeInstrument,
      hedgeSize,
      hedgeType,
      optionType,
      strike: Number.isFinite(strikeValue) ? strikeValue : null,
      coverageLegs: Array.isArray((body as any).coverageLegs)
        ? ((body as any).coverageLegs as any[])
        : undefined,
      notionalUsdc: Number((body as any).notionalUsdc ?? 0) || null,
      floorUsd: Number((body as any).floorUsd ?? 0) || null,
      equityUsd: Number((body as any).equityUsd ?? 0) || null,
      markSource: hedgeVenue === "bybit" || hedgeVenue === "deribit" ? hedgeVenue : null,
      mtmAttribution: "position"
    });
    await saveCoverageLedger();
    (body as any).selectedVenue = entry.selectedVenue ?? (body as any).selectedVenue ?? null;
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
  const coveragePayload = {
    ...body,
    selectedVenue: (body as any).selectedVenue ?? hedgeVenue ?? null,
    coverageLegs:
      (body as any).coverageLegs ??
      (coverageIdValue ? coverageLedger.get(coverageIdValue)?.coverageLegs : null) ??
      null,
    hedge: {
      ...hedge,
      instrument: hedgeInstrument ?? hedge.instrument ?? null,
      hedgeSize: hedgeSize ?? hedge.hedgeSize ?? null,
      hedgeType: hedgeType ?? hedge.hedgeType ?? null,
      optionType: optionType ?? hedge.optionType ?? null,
      strike: Number.isFinite(strikeValue) ? strikeValue : hedge.strike ?? null,
      venue: hedgeVenue ?? hedge.venue ?? null
    }
  };
  const ledgerEntry = coverageIdValue ? coverageLedger.get(coverageIdValue) : null;
  if (ledgerEntry) {
    const issues: Array<{ field: string; expected: unknown; received: unknown }> = [];
    if (
      ledgerEntry.hedgeInstrument &&
      hedgeInstrument &&
      ledgerEntry.hedgeInstrument !== hedgeInstrument
    ) {
      issues.push({
        field: "hedgeInstrument",
        expected: ledgerEntry.hedgeInstrument,
        received: hedgeInstrument
      });
    }
    if (
      ledgerEntry.selectedVenue &&
      coveragePayload.selectedVenue &&
      ledgerEntry.selectedVenue !== coveragePayload.selectedVenue
    ) {
      issues.push({
        field: "selectedVenue",
        expected: ledgerEntry.selectedVenue,
        received: coveragePayload.selectedVenue
      });
    }
    if (
      ledgerEntry.hedgeSize !== null &&
      ledgerEntry.hedgeSize !== undefined &&
      hedgeSize !== null &&
      hedgeSize !== undefined
    ) {
      const sizeDelta = Math.abs(ledgerEntry.hedgeSize - hedgeSize);
      if (sizeDelta > 1e-6) {
        issues.push({
          field: "hedgeSize",
          expected: ledgerEntry.hedgeSize,
          received: hedgeSize
        });
      }
    }
    if (issues.length > 0) {
      await audit("audit_validation_failed", {
        coverageId: coverageIdValue,
        issues,
        selectedVenue: coveragePayload.selectedVenue ?? null
      });
    }
  }
  await audit("coverage_activated", coveragePayload);
  return { status: "ok", file: name };
});

app.post("/admin/reset", async (_req, reply) => {
  if (APP_MODE !== "demo") {
    reply.code(403);
    return { status: "forbidden", message: "Reset is only available in demo mode." };
  }
  const cleared = await clearAuditLogs();
  activeCoverages.clear();
  coverageLedger.clear();
  portfolioSnapshots.clear();
  hedgeLedger.clear();
  realizedHedgePnlUsdc = new Decimal(0);
  resetRiskState();
  try {
    await rm(COVERAGE_FILE_PATH, { force: true });
    await rm(HEDGE_LEDGER_PATH, { force: true });
    await rm(COVERAGE_LEDGER_PATH, { force: true });
  } catch {
    // ignore
  }
  return {
    status: "ok",
    clearedFiles: cleared.cleared
  };
});

app.get("/audit/logs", async (req) => {
  const query = req.query as { limit?: string; showAll?: string };
  const limit = Number(query.limit || "200");
  const showAll = query.showAll === "true";

  const allEntries = await readAuditEntries(limit);
  const entries = showAll
    ? allEntries
    : allEntries.filter((entry) => isCeoRelevantEvent(entry.event as string));

  console.log(
    `[Audit] Total: ${allEntries.length}, Filtered: ${entries.length}, ShowAll: ${showAll}`
  );

  return {
    status: "ok",
    entries,
    count: entries.length,
    totalEvents: allEntries.length,
    filtered: !showAll
  };
});

app.get("/debug/risk-controls", async () => {
  const current = await loadRiskControls(RISK_CONTROLS_PATH);
  let mtime: string | null = null;
  try {
    const info = await stat(RISK_CONTROLS_PATH);
    mtime = new Date(info.mtimeMs).toISOString();
  } catch {
    mtime = null;
  }
  return {
    status: "ok",
    path: RISK_CONTROLS_PATH.pathname,
    mtime,
    controls: {
      pass_through_allow_uncapped_bronze: current.pass_through_allow_uncapped_bronze ?? false,
      pass_through_uncapped_max_ratio: current.pass_through_uncapped_max_ratio ?? null,
      pass_through_cap_by_tier: current.pass_through_cap_by_tier ?? {},
      pass_through_cap_by_leverage: current.pass_through_cap_by_leverage ?? {},
      enable_premium_pass_through: current.enable_premium_pass_through ?? null,
      require_user_opt_in_for_pass_through: current.require_user_opt_in_for_pass_through ?? null,
      premium_floor_ratio: current.premium_floor_ratio ?? null,
      pass_through_min_notification_ratio: current.pass_through_min_notification_ratio ?? null
    }
  };
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
    hedgeType?: "option" | "perp";
    positionSide?: "long" | "short";
    optionType?: "put" | "call";
  };

  const bufferPct = new Decimal(body.bufferPct);
  const decision = evaluateRollingHedge({
    bufferPct,
    hedgeState: {
      bufferTargetPct: new Decimal(body.bufferTargetPct),
      hysteresisPct: new Decimal(body.hysteresisPct)
    },
    expiryIso: body.expiryIso,
    renewWindowMinutes: body.renewWindowMinutes,
    positionSide: body.positionSide || "long",
    currentOptionType: body.optionType || "put",
    hedgeType: body.hedgeType || "option"
  });

  if (decision.hedgeAction === "increase") {
    await deribit.placeOrder({
      instrument: body.hedgeInstrument,
      amount: body.hedgeSize,
      side: decision.recommendedSide,
      type: "market"
    });
  }

  return {
    decision
  };
});

const startServer = async () => {
  try {
    console.log("[API] Starting server...");
    await app.listen({ port: API_PORT, host: API_HOST });
    console.log(`[API] Listening on http://${API_HOST}:${API_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const bootstrapState = async () => {
  await ensureLogsDir();
  try {
    await seedAuditIfEmpty();
  } catch (error) {
    console.error("Failed to seed audit log:", error);
  }
  try {
    await loadCoverages();
  } catch (error) {
    console.error("Failed to load coverages:", error);
  }
  try {
    await loadCoverageLedger();
  } catch (error) {
    console.error("Failed to load coverage ledger:", error);
  }
  try {
    await loadHedgeLedger();
  } catch (error) {
    console.error("Failed to load hedge ledger:", error);
  }
};

await startServer();
void bootstrapState();

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
      await computeCoverageMtmSnapshots();
    } catch (err) {
      app.log.error(err);
    }
  }, MTM_INTERVAL_MS);
}
