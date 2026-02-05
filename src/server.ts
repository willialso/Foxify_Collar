import Fastify from "fastify";
import cors from "@fastify/cors";
import { appendFile, readFile } from "node:fs/promises";
import Decimal from "decimal.js";
import { DeribitConnector } from "@foxify/connectors";
import {
  applyRiskAccounting,
  liquiditySummary,
  loadRiskControls,
  resetRiskState,
  riskSummary,
  serializeLiquidityState
} from "./riskControls";
import { createDeribitIvCache } from "./deribitIvCache";
import { createDeribitIvLadderCache } from "./deribitIvLadder";
import { buildExecutionPlan } from "./executionEngine";
import { ExecutionRegistry, createDeribitExecutor } from "./executionRegistry";
import { calculateCtcSafetyFee, calculateFeeBase, normalizeIvValue } from "./pricingEngine";
import { setupMonitoring } from "./monitoring";
import type { RiskControlsConfig } from "./riskControls";

const PORT = Number(process.env.PORT || "8000");
const HOST = process.env.HOST || "0.0.0.0";
const DERIBIT_ENV = (process.env.DERIBIT_ENV as "testnet" | "live") || "testnet";
const DERIBIT_PAPER = process.env.DERIBIT_PAPER !== "false";
const DERIBIT_CLIENT_ID = process.env.DERIBIT_CLIENT_ID;
const DERIBIT_CLIENT_SECRET = process.env.DERIBIT_CLIENT_SECRET;
const QUOTE_CACHE_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS || "4000");
const QUOTE_CACHE_STALE_MS = Number(process.env.QUOTE_CACHE_STALE_MS || "20000");
const QUOTE_CACHE_HARD_MS = Number(process.env.QUOTE_CACHE_HARD_MS || "120000");
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || "./logs/audit.log";
const RISK_CONTROLS_PATH = process.env.RISK_CONTROLS_PATH || "./configs/risk_controls.json";

type QuoteCacheEntry = {
  ts: number;
  response: Record<string, unknown>;
};

type PricingRequest = {
  tierName: string;
  asset: string;
  spotPrice: number;
  drawdownFloorPct: number;
  positionSize: number;
  leverage: number;
  targetDays?: number;
  accountId?: string;
};

type CoverageActivationRequest = {
  coverageId: string;
  tierName: string;
  asset: string;
  spotPrice: number;
  drawdownFloorPct: number;
  positionSize: number;
  leverage: number;
  targetDays: number;
  expiryTag: string;
  feeUsdc: number;
  allowPerpFallback: boolean;
  accountId?: string;
};

const quoteCache = new Map<string, QuoteCacheEntry>();

function buildQuoteCacheKey(body: PricingRequest): string {
  const spot = new Decimal(body.spotPrice || 0).toFixed(2);
  const drawdown = new Decimal(body.drawdownFloorPct || 0).toFixed(4);
  const positionSize = new Decimal(body.positionSize || 0).toFixed(6);
  const leverage = new Decimal(body.leverage || 0).toFixed(2);
  const targetDays = Number(body.targetDays || 0);

  return JSON.stringify({
    tierName: body.tierName || "",
    asset: (body.asset || "BTC").toUpperCase(),
    spot,
    drawdown,
    positionSize,
    leverage,
    targetDays
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

  try {
    await appendFile(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}

async function readAuditEntries(limit = 200): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(AUDIT_LOG_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => {
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

type ServerOverrides = {
  riskControls?: RiskControlsConfig;
  deribit?: DeribitConnector;
  executionRegistry?: ExecutionRegistry;
  ivCache?: ReturnType<typeof createDeribitIvCache>;
  ivLadder?: ReturnType<typeof createDeribitIvLadderCache>;
  auditLogPath?: string;
};

export async function createServer(overrides: ServerOverrides = {}) {
  const auditPath = overrides.auditLogPath || AUDIT_LOG_PATH;
  let coverageCounter = 0;
  let totalExecutionTimeMs = 0;
  let totalExecutionCount = 0;
  let premiumCollectedUsdc = new Decimal(0);

  const riskControls =
    overrides.riskControls ?? (await loadRiskControls(new URL(RISK_CONTROLS_PATH, import.meta.url)));
  console.log("✓ Risk controls loaded");

  const deribit =
    overrides.deribit ??
    new DeribitConnector(
      DERIBIT_ENV,
      DERIBIT_PAPER,
      DERIBIT_CLIENT_ID && DERIBIT_CLIENT_SECRET
        ? { clientId: DERIBIT_CLIENT_ID, clientSecret: DERIBIT_CLIENT_SECRET }
        : undefined
    );
  console.log(`✓ Deribit connector initialized (${DERIBIT_ENV}, paper=${DERIBIT_PAPER})`);

  const executionRegistry =
    overrides.executionRegistry ?? (() => {
      const registry = new ExecutionRegistry();
      registry.register("deribit", createDeribitExecutor(deribit));
      return registry;
    })();
  console.log("✓ Execution registry initialized");

  const ivCache =
    overrides.ivCache ??
    createDeribitIvCache(deribit, {
      ttlMs: 15000,
      fallbackIv: 0.5
    });
  console.log("✓ IV cache initialized");

  const ivLadder =
    overrides.ivLadder ??
    createDeribitIvLadderCache(deribit, {
      asset: "BTC",
      expiriesDays: [1, 2, 3, 5, 7],
      floorPcts: [0.12, 0.16, 0.2],
      refreshMs: 300000,
      maxAgeMs: 5000,
      maxSnapshotAgeMs: riskControls.ctc_max_snapshot_age_ms ?? 10000,
      priceBufferPct: riskControls.ctc_price_buffer_pct ?? 0.02
    });

  let ladderReady = Boolean(overrides.ivLadder?.getSnapshot());
  if (!overrides.ivLadder) {
    ivLadder.start();
    console.log("✓ IV ladder started");
    const ladderWarmup = setInterval(() => {
      const snapshot = ivLadder.getSnapshot();
      if (snapshot) {
        console.log(
          `✓ IV ladder ready: base=${snapshot.baseIv.toFixed(4)} hedge=${snapshot.hedgeIv.toFixed(4)}`
        );
        ladderReady = true;
        clearInterval(ladderWarmup);
      }
    }, 1000);

    setTimeout(() => {
      if (!ladderReady) {
        console.warn("⚠ IV ladder warmup timeout - continuing with fallback pricing");
        clearInterval(ladderWarmup);
      }
    }, 15000);
  }

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  setupMonitoring(app, {
    getQuoteCacheSize: () => quoteCache.size,
    getIvLadderReady: () => ladderReady,
    getCoverageCount: () => coverageCounter,
    getPremiumCollectedUsdc: () => premiumCollectedUsdc,
    getAverageExecutionTimeMs: () =>
      totalExecutionCount ? Math.round(totalExecutionTimeMs / totalExecutionCount) : 0
  });

  app.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      deribitEnv: DERIBIT_ENV,
      ivLadderReady: ladderReady
    };
  });

  app.post<{ Body: PricingRequest }>("/pricing/ctc", async (request, reply) => {
    const body = request.body;

    if (
      !body?.tierName ||
      !body?.spotPrice ||
      !body?.drawdownFloorPct ||
      !body?.positionSize ||
      !body?.leverage
    ) {
      return reply.status(400).send({
        status: "error",
        reason: "missing_required_fields",
        required: ["tierName", "spotPrice", "drawdownFloorPct", "positionSize", "leverage"]
      });
    }

    const cacheKey = buildQuoteCacheKey(body);
    const cached = getQuoteCache(cacheKey);

    if (cached && isQuoteCacheFresh(cached)) {
      await audit("pricing_cache_hit", {
        cacheAge: Date.now() - cached.ts,
        tierName: body.tierName
      });
      return cached.response;
    }

    if (cached && isQuoteCacheStale(cached)) {
      reply.header("X-Cache-Age", String(Date.now() - cached.ts));
      await audit("pricing_cache_stale", {
        cacheAge: Date.now() - cached.ts,
        tierName: body.tierName
      });
      return cached.response;
    }

    try {
      const spotPrice = new Decimal(body.spotPrice);
      const drawdownPct = new Decimal(body.drawdownFloorPct);
      const positionSize = new Decimal(body.positionSize);
      const leverage = Number(body.leverage);
      const targetDays = body.targetDays || riskControls.default_target_days || 7;
      const asset = body.asset?.toUpperCase() || "BTC";

      const ladder = ivLadder.getSnapshot();
      const ivSnapshot = ladder
        ? normalizeIvValue(ladder.hedgeIv)
        : normalizeIvValue(Number((await ivCache.getAtmIv(asset)).toFixed(6)));

      let ctcResult = { feeUsdc: null, baseIv: null, hedgeIv: null };
      if (riskControls.ctc_enabled && ladder) {
        ctcResult = calculateCtcSafetyFee(
          {
            tierName: body.tierName,
            drawdownPct,
            spotPrice,
            positionSize,
            leverage
          },
          ladder,
          riskControls
        );
      }

      const minBaseFee = riskControls.min_fee_usdc_by_tier?.[body.tierName] || 20;
      const feeBase = await calculateFeeBase(
        {
          tierName: body.tierName,
          baseFeeUsdc: new Decimal(minBaseFee),
          targetDays,
          leverage,
          asset,
          ivCandidate: ivSnapshot.scaled
        },
        ivSnapshot,
        riskControls
      );

      const finalFee =
        body.tierName !== "Pro (Bronze)" && ctcResult.feeUsdc && ctcResult.feeUsdc.gt(feeBase.feeUsdc)
          ? ctcResult.feeUsdc
          : feeBase.feeUsdc;

      const response = {
        status: "ok",
        tierName: body.tierName,
        feeUsdc: finalFee.toFixed(2),
        ctcUsed: ctcResult.feeUsdc !== null && ctcResult.feeUsdc.gt(feeBase.feeUsdc),
        ctcFeeUsdc: ctcResult.feeUsdc ? ctcResult.feeUsdc.toFixed(2) : null,
        baseFeeUsdc: feeBase.feeUsdc.toFixed(2),
        feeRegime: feeBase.feeRegime.regime,
        feeRegimeMultiplier: feeBase.feeRegime.multiplier?.toFixed(4) || null,
        feeLeverageMultiplier: feeBase.feeLeverage.multiplier?.toFixed(4) || null,
        markIv: ivSnapshot.raw,
        baseIv: ctcResult.baseIv,
        hedgeIv: ctcResult.hedgeIv,
        targetDays,
        quoteLockExpiry: new Date(Date.now() + QUOTE_CACHE_TTL_MS).toISOString()
      };

      setQuoteCache(cacheKey, response);
      await audit("pricing_calculated", {
        tierName: body.tierName,
        feeUsdc: finalFee.toFixed(2),
        ctcUsed: response.ctcUsed,
        accountId: body.accountId || null
      });

      return response;
    } catch (error) {
      if (cached && isQuoteCacheUsable(cached)) {
        reply.header("X-Cache-Age", String(Date.now() - cached.ts));
        await audit("pricing_cache_fallback", {
          cacheAge: Date.now() - cached.ts,
          tierName: body.tierName,
          error: String(error)
        });
        return cached.response;
      }

      return reply.status(500).send({
        status: "error",
        reason: "pricing_failed",
        message: String(error)
      });
    }
  });

  app.post<{ Body: CoverageActivationRequest }>("/coverage/activate", async (request, reply) => {
    const body = request.body;

    if (!body?.coverageId || !body?.tierName || !body?.spotPrice || !body?.feeUsdc) {
      return reply.status(400).send({
        status: "error",
        reason: "missing_required_fields"
      });
    }

    const spotPrice = new Decimal(body.spotPrice);
    const drawdownPct = new Decimal(body.drawdownFloorPct);
    const positionSize = new Decimal(body.positionSize);
    const targetSize = positionSize;

    const executionResult = await buildExecutionPlan(
      {
        spotPrice,
        drawdownFloorPct: drawdownPct,
        targetSize,
        optionType: "put",
        expiryTag: body.expiryTag,
        targetDays: body.targetDays,
        allowPerpFallback: body.allowPerpFallback
      },
      deribit,
      executionRegistry
    );

    if (executionResult.status === "failed") {
      await audit("coverage_failed", {
        coverageId: body.coverageId,
        reason: "execution_failed",
        attempts: executionResult.attempts.length
      });

      return reply.status(400).send({
        status: "error",
        reason: "execution_failed",
        attempts: executionResult.attempts.map((a) => ({
          instrument: a.instrument,
          success: a.success,
          failureReason: a.failureReason
        }))
      });
    }

    const feeUsdc = new Decimal(body.feeUsdc);
    const premiumUsdc = executionResult.totalCostUsdc;
    const notionalUsdc = spotPrice.mul(positionSize).mul(new Decimal(body.leverage));

    const accounting = applyRiskAccounting(body.tierName, feeUsdc, premiumUsdc, notionalUsdc);
    coverageCounter += 1;
    totalExecutionTimeMs += executionResult.executionTimeMs;
    totalExecutionCount += 1;
    premiumCollectedUsdc = premiumCollectedUsdc.plus(premiumUsdc);

    await audit("coverage_activated", {
      coverageId: body.coverageId,
      tierName: body.tierName,
      feeUsdc: feeUsdc.toFixed(2),
      premiumUsdc: premiumUsdc.toFixed(2),
      status: executionResult.status,
      instrument: executionResult.finalInstrument,
      filledSize: executionResult.totalFilled.toFixed(4),
      coverageRatio: executionResult.coverageRatio.times(100).toFixed(2),
      executionTimeMs: executionResult.executionTimeMs,
      attempts: executionResult.attempts.length,
      accountId: body.accountId || null
    });

    return {
      status: "success",
      coverageId: body.coverageId,
      executionStatus: executionResult.status,
      instrument: executionResult.finalInstrument,
      hedgeSize: executionResult.totalFilled.toFixed(4),
      averageFillPrice: executionResult.averageFillPrice?.toFixed(6) || null,
      premiumUsdc: premiumUsdc.toFixed(2),
      feeUsdc: feeUsdc.toFixed(2),
      coverageRatio: executionResult.coverageRatio.times(100).toFixed(2),
      profitMargin: feeUsdc.minus(premiumUsdc).toFixed(2),
      executionTimeMs: executionResult.executionTimeMs,
      attempts: executionResult.attempts.map((a) => ({
        instrument: a.instrument,
        strike: a.strike,
        attemptNumber: a.attemptNumber,
        filledSize: a.filledSize.toFixed(4),
        fillPrice: a.fillPrice?.toFixed(6) || null,
        success: a.success,
        failureReason: a.failureReason
      })),
      liquidityDelta: {
        liquidityBalanceUsdc: accounting.liquidityDelta.liquidityBalanceUsdc.toFixed(2),
        profitUsdc: accounting.liquidityDelta.profitUsdc.toFixed(2)
      }
    };
  });

  app.get("/audit/logs", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number(query.limit || "200");
    const entries = await readAuditEntries(limit);
    return { entries, count: entries.length };
  });

  app.get("/risk/summary", async () => {
    const riskState = riskSummary();
    const liquidityState = liquiditySummary();

    const risk = Object.fromEntries(
      Object.entries(riskState).map(([tier, state]) => [
        tier,
        {
          dateKey: state.dateKey,
          revenueUsdc: state.revenueUsdc.toFixed(2),
          overageUsdc: state.overageUsdc.toFixed(2),
          notionalUsdc: state.notionalUsdc.toFixed(2)
        }
      ])
    );

    return {
      risk,
      liquidity: serializeLiquidityState(liquidityState)
    };
  });

  app.post("/admin/reset", async () => {
    resetRiskState();
    quoteCache.clear();
    await audit("admin_reset", { reason: "manual_reset" });
    return { status: "ok" };
  });

  return { app, riskControls, deribit, executionRegistry, ivCache, ivLadder, auditPath };
}

const start = async () => {
  try {
    const { app, riskControls } = await createServer();
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n🚀 Atticus MVP server running on http://${HOST}:${PORT}`);
    console.log(`   Environment: ${DERIBIT_ENV}`);
    console.log(`   Paper mode: ${DERIBIT_PAPER}`);
    console.log(`   CTC enabled: ${riskControls.ctc_enabled}`);
    console.log(`   Quote cache TTL: ${QUOTE_CACHE_TTL_MS}ms`);
    console.log(`\n📊 Endpoints:`);
    console.log(`   GET  /health`);
    console.log(`   POST /pricing/ctc`);
    console.log(`   POST /coverage/activate`);
    console.log(`   GET  /audit/logs`);
    console.log(`   GET  /risk/summary`);
    console.log(`   POST /admin/reset`);
    console.log(`\n✨ Ready to serve requests\n`);

    await audit("server_started", {
      port: PORT,
      host: HOST,
      deribitEnv: DERIBIT_ENV,
      deribitPaper: DERIBIT_PAPER,
      ctcEnabled: riskControls.ctc_enabled
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
