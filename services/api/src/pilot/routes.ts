import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { DeribitConnector } from "@foxify/connectors";
import { buildUserHash } from "./hash";
import { pilotConfig, resolvePilotWindow } from "./config";
import {
  countProtectionsByUserHash,
  createPilotTermsAcceptanceIfMissing,
  ensurePilotSchema,
  getDailyProtectedNotionalForUser,
  getEssentialProofPayload,
  getPilotAdminMetrics,
  getPilotTermsAcceptance,
  getPilotPool,
  getProtection,
  getProtectionForUpdate,
  getVenueQuoteByQuoteIdForUpdate,
  insertAdminAction,
  consumeVenueQuote,
  insertLedgerEntry,
  insertPriceSnapshot,
  insertProtection,
  insertVenueExecution,
  insertVenueQuote,
  markProtectionAwaitingExpiryPriceIfUnresolved,
  releaseDailyActivationCapacity,
  reserveDailyActivationCapacity,
  listLedgerForProtection,
  listProtectionsByUserHash,
  patchProtection
} from "./db";
import { resolvePriceSnapshot, type PriceSnapshotOutput } from "./price";
import { createPilotVenueAdapter, mapVenueFailureReason } from "./venue";
import {
  computeTriggerPrice,
  computePayoutDue,
  normalizeProtectionType,
  normalizeTierName,
  resolveDrawdownFloorPct,
  resolveExpiryDays,
  resolveRenewWindowMinutes
} from "./floor";

const getRequestIp = (req: FastifyRequest): string => {
  // Use Fastify-resolved client IP. Raw x-forwarded-for is not trusted by default.
  return req.ip;
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
};

const parsePositiveInt = (value: unknown, fallback: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const parseNonNegativeInt = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
};

const parsePositiveDecimal = (value: unknown): Decimal | null => {
  try {
    const parsed = new Decimal(value as Decimal.Value);
    if (!parsed.isFinite() || parsed.lte(0)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const parseDecimalValue = (value: unknown): Decimal | null => {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = new Decimal(value as Decimal.Value);
    if (!parsed.isFinite()) return null;
    return parsed;
  } catch {
    return null;
  }
};

const resolveReferenceVenueLabel = (url: string, fallbackLabel = "Reference Feed"): string => {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("coinbase")) return "Coinbase";
    if (hostname.includes("deribit")) return "Deribit";
    if (hostname.includes("falconx")) return "FalconX";
    return hostname.replace(/^www\./, "") || fallbackLabel;
  } catch {
    return fallbackLabel;
  }
};

const resolveTierPremiumFloorBps = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumFloorBpsByTier[tierName] ?? 100);
  if (!Number.isFinite(raw) || raw < 0) return new Decimal(0);
  return new Decimal(raw);
};

const resolveTierPremiumFloorUsd = (tierName: string): Decimal => {
  const raw = Number(pilotConfig.premiumFloorUsdByTier[tierName] ?? 0);
  if (!Number.isFinite(raw) || raw < 0) return new Decimal(0);
  return new Decimal(raw);
};

const resolvePremiumPricing = (params: {
  tierName: string;
  protectedNotional: Decimal;
  hedgePremium: Decimal;
}): {
  hedgePremiumUsd: Decimal;
  markupPct: Decimal;
  markupUsd: Decimal;
  premiumFloorUsdAbsolute: Decimal;
  premiumFloorUsdFromBps: Decimal;
  premiumFloorBps: Decimal;
  premiumFloorUsd: Decimal;
  clientPremiumUsd: Decimal;
  method: "markup" | "floor_usd" | "floor_bps";
} => {
  const markupPctRaw = Number(
    pilotConfig.premiumMarkupPctByTier[params.tierName] ?? pilotConfig.premiumMarkupPct
  );
  const markupPct = Number.isFinite(markupPctRaw) && markupPctRaw > 0 ? new Decimal(markupPctRaw) : new Decimal(0);
  const hedgePremiumUsd = params.hedgePremium;
  const markupUsd = hedgePremiumUsd.mul(markupPct);
  const markedUpPremium = hedgePremiumUsd.plus(markupUsd);
  const premiumFloorBps = resolveTierPremiumFloorBps(params.tierName);
  const premiumFloorUsdFromBps = params.protectedNotional.mul(premiumFloorBps).div(10000);
  const premiumFloorUsdAbsolute = resolveTierPremiumFloorUsd(params.tierName);
  const premiumFloorUsd = Decimal.max(premiumFloorUsdAbsolute, premiumFloorUsdFromBps);
  const clientPremiumUsd = Decimal.max(markedUpPremium, premiumFloorUsd);
  const method: "markup" | "floor_usd" | "floor_bps" = clientPremiumUsd.eq(markedUpPremium)
    ? "markup"
    : premiumFloorUsdAbsolute.greaterThanOrEqualTo(premiumFloorUsdFromBps)
      ? "floor_usd"
      : "floor_bps";
  return {
    hedgePremiumUsd,
    markupPct,
    markupUsd,
    premiumFloorUsdAbsolute,
    premiumFloorUsdFromBps,
    premiumFloorBps,
    premiumFloorUsd,
    clientPremiumUsd,
    method
  };
};

const sanitizeQuoteForClient = (quote: {
  venue: string;
  quoteId: string;
  rfqId?: string | null;
  instrumentId: string;
  side: "buy";
  quantity: number;
  premium: number;
  expiresAt: string;
  quoteTs: string;
  details?: Record<string, unknown>;
}): {
  venue: string;
  quoteId: string;
  rfqId?: string | null;
  instrumentId: string;
  side: "buy";
  quantity: number;
  premium: number;
  expiresAt: string;
  quoteTs: string;
  details?: Record<string, unknown>;
} => {
  const details = quote.details || {};
  const allowedDetails: Record<string, unknown> = {};
  const allowedKeys = ["mode", "source", "pricing", "askPriceBtc", "askSize", "spotPriceUsd", "optionType"];
  for (const key of allowedKeys) {
    if (key in details) allowedDetails[key] = details[key];
  }
  const base = {
    venue: quote.venue,
    quoteId: quote.quoteId,
    instrumentId: quote.instrumentId,
    side: quote.side,
    quantity: quote.quantity,
    premium: quote.premium,
    expiresAt: quote.expiresAt,
    quoteTs: quote.quoteTs
  };
  return {
    ...base,
    ...(quote.rfqId !== undefined ? { rfqId: quote.rfqId } : {}),
    details: Object.keys(allowedDetails).length > 0 ? allowedDetails : undefined
  };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const inferProtectionTypeFromInstrument = (instrumentId: string | null | undefined): "long" | "short" => {
  const normalized = String(instrumentId || "").toUpperCase();
  return normalized.endsWith("-C") ? "short" : "long";
};

const resolveProtectionTypeFromRecord = (protection: { instrumentId?: string | null; metadata?: Record<string, unknown> }): "long" | "short" =>
  normalizeProtectionType(
    String(protection.metadata?.protectionType || inferProtectionTypeFromInstrument(protection.instrumentId))
  );

const sanitizeProtectionForTrader = (protection: Record<string, unknown>): Record<string, unknown> => {
  const { userHash: _userHash, hashVersion: _hashVersion, ...safe } = protection;
  return safe;
};

const isAdminAuthorized = (req: FastifyRequest): boolean => {
  const token = String(req.headers["x-admin-token"] || "");
  if (!pilotConfig.adminToken || token !== pilotConfig.adminToken) return false;
  const actorIp = getRequestIp(req);
  if (
    pilotConfig.adminIpAllowlist.entries.length > 0 &&
    !pilotConfig.adminIpAllowlist.entries.includes(actorIp)
  ) {
    return false;
  }
  return true;
};

const isProofAuthorized = (req: FastifyRequest): boolean => {
  if (!pilotConfig.proofToken) return false;
  const headerToken = String(req.headers["x-proof-token"] || "");
  const auth = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const token = headerToken || bearer;
  return Boolean(token && token === pilotConfig.proofToken);
};

const requireAdmin = async (
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ actor: string; actorIp: string } | null> => {
  const actor = String(req.headers["x-admin-actor"] || "pilot-ops");
  const actorIp = getRequestIp(req);
  if (!isAdminAuthorized(req)) {
    reply.code(401).send({ status: "error", reason: "unauthorized_admin" });
    return null;
  }
  return { actor, actorIp };
};

const requireProofAccess = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
  if (!pilotConfig.proofToken) {
    reply.code(503).send({ status: "error", reason: "proof_auth_not_configured" });
    return false;
  }
  if (!isProofAuthorized(req)) {
    reply.code(401).send({ status: "error", reason: "unauthorized_proof_access" });
    return false;
  }
  return true;
};

const resolveTenantScopeHash = (): { userHash: string; hashVersion: number } =>
  buildUserHash({
    rawUserId: pilotConfig.tenantScopeId,
    secret: pilotConfig.hashSecret,
    hashVersion: pilotConfig.hashVersion
  });

const requireInternalOrAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
  const internalToken = String(req.headers["x-internal-token"] || "");
  if (pilotConfig.internalToken && internalToken === pilotConfig.internalToken) {
    return true;
  }
  const admin = await requireAdmin(req, reply);
  return Boolean(admin);
};

const enforcePilotWindow = (reply: FastifyReply): boolean => {
  const window = resolvePilotWindow(new Date());
  if (window.status === "open") return true;
  if (window.status === "config_invalid") {
    reply.code(500).send({
      status: "error",
      reason: "pilot_window_config_invalid",
      detail: window.reason || "pilot_window_invalid"
    });
    return false;
  }
  if (window.status === "not_started") {
    reply.code(403).send({
      status: "error",
      reason: "pilot_not_started",
      startAt: window.startAt,
      endAt: window.endAt
    });
    return false;
  }
  if (window.status === "closed") {
    reply.code(403).send({
      status: "error",
      reason: "pilot_window_closed",
      startAt: window.startAt,
      endAt: window.endAt
    });
    return false;
  }
  return true;
};

const toCsv = (rows: Array<Record<string, unknown>>): string => {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    const str = value === null || value === undefined ? "" : String(value);
    if (str.includes(",") || str.includes("\"") || str.includes("\n")) {
      return `"${str.replace(/"/g, "\"\"")}"`;
    }
    return str;
  };
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((col) => escape(row[col])).join(",")).join("\n");
  return `${header}\n${body}`;
};

export const registerPilotRoutes = async (
  app: FastifyInstance,
  deps: { deribit: DeribitConnector }
): Promise<void> => {
  if (!pilotConfig.enabled) return;
  const pool = getPilotPool(pilotConfig.postgresUrl);
  await ensurePilotSchema(pool);
  const venue = createPilotVenueAdapter({
    mode: pilotConfig.venueMode,
    quoteTtlMs: pilotConfig.quoteTtlMs,
    deribitQuotePolicy: pilotConfig.deribitQuotePolicy,
    deribitStrikeSelectionMode: pilotConfig.deribitStrikeSelectionMode,
    falconx: {
      baseUrl: pilotConfig.falconxBaseUrl,
      apiKey: pilotConfig.falconxApiKey,
      secret: pilotConfig.falconxSecret,
      passphrase: pilotConfig.falconxPassphrase
    },
    deribit: deps.deribit
  });

  const requireTermsAcceptance = async (
    reply: FastifyReply,
    userHash: { userHash: string; hashVersion: number }
  ): Promise<boolean> => {
    try {
      const acceptance = await getPilotTermsAcceptance(pool, {
        userHash: userHash.userHash,
        termsVersion: pilotConfig.termsVersion
      });
      if (acceptance) return true;
      reply.code(403).send({
        status: "error",
        reason: "terms_not_accepted",
        termsVersion: pilotConfig.termsVersion
      });
      return false;
    } catch (error: any) {
      reply.code(503).send({
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "terms_enforcement_failed")
      });
      return false;
    }
  };

  const resolveScopedUserHash = (reply: FastifyReply): string | null => {
    try {
      return resolveTenantScopeHash().userHash;
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400).send({ status: "error", reason });
      return null;
    }
  };

  const resolveAndPersistExpiry = async (protectionId: string): Promise<void> => {
    const protection = await getProtection(pool, protectionId);
    if (!protection) return;
    if (!["active", "awaiting_expiry_price"].includes(protection.status)) return;
    const expiryAt = new Date(protection.expiryAt);
    if (Date.now() < expiryAt.getTime()) return;
    const requestId = pilotConfig.nextRequestId();
    try {
      const snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.referencePriceUrl,
          fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
          requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
          requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
        },
        {
          marketId: protection.marketId,
          now: new Date(),
          expiryAt,
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const locked = await getProtectionForUpdate(client, protectionId);
        if (!locked) {
          await client.query("COMMIT");
          transactionOpen = false;
          return;
        }
        if (!["active", "awaiting_expiry_price"].includes(locked.status) || locked.expiryPrice) {
          await client.query("COMMIT");
          transactionOpen = false;
          return;
        }
        const lockedExpiryAt = new Date(locked.expiryAt);
        if (Date.now() < lockedExpiryAt.getTime()) {
          await client.query("COMMIT");
          transactionOpen = false;
          return;
        }
        await insertPriceSnapshot(client, {
          id: `${protectionId}:expiry`,
          protectionId,
          snapshotType: "expiry",
          price: snapshot.price.toFixed(10),
          marketId: snapshot.marketId,
          priceSource: snapshot.priceSource,
          priceSourceDetail: snapshot.priceSourceDetail,
          endpointVersion: snapshot.endpointVersion,
          requestId: snapshot.requestId,
          priceTimestamp: snapshot.priceTimestamp
        });
        const entryPrice = new Decimal(locked.entryPrice || "0");
        const protectedNotional = new Decimal(locked.protectedNotional);
        const expiryPrice = snapshot.price;
        const drawdownFloorPct = new Decimal(locked.drawdownFloorPct || "0.2");
        const protectionType = resolveProtectionTypeFromRecord(locked);
        const triggerPrice = locked.floorPrice
          ? new Decimal(locked.floorPrice)
          : computeTriggerPrice(entryPrice, drawdownFloorPct, protectionType);
        const payoutDue = computePayoutDue({
          protectedNotional,
          entryPrice,
          triggerPrice,
          expiryPrice,
          protectionType
        });
        const nextStatus = payoutDue.gt(0) ? "expired_itm" : "expired_otm";
        await patchProtection(client, protectionId, {
          status: nextStatus,
          expiry_price: snapshot.price.toFixed(10),
          expiry_price_source: snapshot.priceSource,
          expiry_price_timestamp: snapshot.priceTimestamp,
          floor_price: triggerPrice.toFixed(10),
          payout_due_amount: payoutDue.toFixed(10)
        });
        if (payoutDue.gt(0)) {
          await insertLedgerEntry(client, {
            id: `${protectionId}:payout_due`,
            protectionId,
            entryType: "payout_due",
            amount: payoutDue.toFixed(10),
            reference: `expiry:${snapshot.priceTimestamp}`
          });
        }
        await client.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      try {
        const latest = await getProtection(pool, protectionId);
        await markProtectionAwaitingExpiryPriceIfUnresolved(pool, protectionId, {
          ...(latest?.metadata || {}),
          expiryError: String(error?.message || "expiry_price_unavailable")
        });
      } catch {
        // swallow to keep scheduler resilient
      }
    }
  };

  app.get("/pilot/terms/status", async (req, reply) => {
    const query = req.query as { termsVersion?: string };
    if (query.termsVersion && String(query.termsVersion) !== pilotConfig.termsVersion) {
      reply.code(400);
      return {
        status: "error",
        reason: "terms_version_mismatch",
        expectedTermsVersion: pilotConfig.termsVersion
      };
    }
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    try {
      const acceptance = await getPilotTermsAcceptance(pool, {
        userHash: userHash.userHash,
        termsVersion: pilotConfig.termsVersion
      });
      return {
        status: "ok",
        termsVersion: pilotConfig.termsVersion,
        accepted: Boolean(acceptance),
        acceptedAt: acceptance?.acceptedAt || null
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "terms_status_failed")
      };
    }
  });

  app.post("/pilot/terms/accept", async (req, reply) => {
    const body = req.body as { termsVersion?: string; accepted?: boolean };
    if (body.termsVersion && String(body.termsVersion) !== pilotConfig.termsVersion) {
      reply.code(400);
      return {
        status: "error",
        reason: "terms_version_mismatch",
        expectedTermsVersion: pilotConfig.termsVersion
      };
    }
    if (body.accepted === false) {
      reply.code(400);
      return { status: "error", reason: "acceptance_required" };
    }
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    const userAgent = String(req.headers["user-agent"] || "").trim() || null;
    try {
      const accepted = await createPilotTermsAcceptanceIfMissing(pool, {
        userHash: userHash.userHash,
        hashVersion: userHash.hashVersion,
        termsVersion: pilotConfig.termsVersion,
        acceptedIp: getRequestIp(req),
        userAgent,
        source: "pilot_web",
        details: {
          endpointVersion: pilotConfig.endpointVersion,
          requestId: pilotConfig.nextRequestId()
        }
      });
      return {
        status: "ok",
        termsVersion: pilotConfig.termsVersion,
        acceptanceId: accepted.record.id,
        acceptedAt: accepted.record.acceptedAt,
        firstAcceptance: accepted.created
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "terms_accept_failed")
      };
    }
  });

  app.get("/pilot/reference-price", async (req, reply) => {
    const query = req.query as { marketId?: string };
    const marketId = String(query.marketId || pilotConfig.referenceMarketId || "BTC-USD");
    const requestId = pilotConfig.nextRequestId();
    try {
      const snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.referencePriceUrl,
          fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
          requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
          requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
        },
        {
          marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      const ageMs = Math.max(0, Date.now() - Date.parse(snapshot.priceTimestamp));
      const venue =
        snapshot.priceSource === "fallback_oracle"
          ? resolveReferenceVenueLabel(pilotConfig.fallbackPriceUrl)
          : resolveReferenceVenueLabel(pilotConfig.referencePriceUrl);
      return {
        status: "ok",
        reference: {
          price: snapshot.price.toFixed(10),
          marketId: snapshot.marketId,
          venue,
          source: snapshot.priceSource,
          timestamp: snapshot.priceTimestamp,
          requestId: snapshot.requestId,
          ageMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs
        }
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String(error?.message || "reference_price_unavailable")
      };
    }
  });

  app.post("/pilot/protections/quote", async (req, reply) => {
    if (!enforcePilotWindow(reply)) return;
    const body = req.body as {
      protectedNotional?: number;
      foxifyExposureNotional?: number;
      entryPrice?: number;
      instrumentId?: string;
      marketId?: string;
      clientOrderId?: string;
      tierName?: string;
      drawdownFloorPct?: number;
      protectionType?: "long" | "short";
    };
    const quoteStartedAt = Date.now();
    const protectedNotional = parsePositiveDecimal(body.protectedNotional);
    const exposureNotional = parsePositiveDecimal(body.foxifyExposureNotional);
    const entryInputPrice = parsePositiveDecimal(body.entryPrice);
    if (!protectedNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_protected_notional" };
    }
    if (!exposureNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_exposure_notional" };
    }
    const maxProtection = new Decimal(pilotConfig.maxProtectionNotionalUsdc);
    const maxDailyProtection = new Decimal(pilotConfig.maxDailyProtectedNotionalUsdc);
    if (protectedNotional.gt(maxProtection)) {
      reply.code(400);
      return {
        status: "error",
        reason: "protection_notional_cap_exceeded",
        capUsdc: maxProtection.toFixed(2)
      };
    }
    if (protectedNotional.gt(exposureNotional)) {
      reply.code(400);
      return { status: "error", reason: "protected_notional_exceeds_exposure" };
    }
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    if (!(await requireTermsAcceptance(reply, userHash))) return;
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    let dailyUsed: Decimal;
    try {
      dailyUsed = new Decimal(
        await getDailyProtectedNotionalForUser(
          pool,
          userHash.userHash,
          dayStart.toISOString(),
          dayEnd.toISOString()
        )
      );
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "daily_limit_query_failed")
      };
    }
    const projectedDaily = dailyUsed.plus(protectedNotional);
    const marketId = pilotConfig.referenceMarketId;
    const protectionType = normalizeProtectionType(body.protectionType);
    const optionType = protectionType === "short" ? "C" : "P";
    const quoteInstrumentId = body.instrumentId || `${marketId}-7D-${optionType}`;
    const triggerLabel = protectionType === "short" ? "ceiling_price" : "floor_price";
    const tierName = normalizeTierName(body.tierName);
    const drawdownFloorPct = resolveDrawdownFloorPct({
      tierName,
      drawdownFloorPct: body.drawdownFloorPct
    });
    const requestId = pilotConfig.nextRequestId();
    let priceMs = 0;
    let venueMs = 0;
    let snapshot: PriceSnapshotOutput;
    try {
      const priceStartedAt = Date.now();
      snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.referencePriceUrl,
          fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
          requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
          requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
        },
        {
          marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      priceMs = Date.now() - priceStartedAt;
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String(error?.message || "price_chain_error"),
        diagnostics: { requestId, stage: "price_snapshot", elapsedMs: Date.now() - quoteStartedAt }
      };
    }
    try {
      const entryAnchorPrice = snapshot.price;
      const triggerPrice = computeTriggerPrice(entryAnchorPrice, drawdownFloorPct, protectionType);
      const quantity = protectedNotional.div(entryAnchorPrice).toDecimalPlaces(8).toNumber();
      const venueStartedAt = Date.now();
      const quote = await withTimeout(
        venue.quote({
          marketId,
          protectedNotional: protectedNotional.toNumber(),
          quantity,
          side: "buy",
          triggerPrice: Number(triggerPrice.toFixed(10)),
          protectionType,
          instrumentId: quoteInstrumentId,
          clientOrderId: body.clientOrderId
        }),
        pilotConfig.venueQuoteTimeoutMs,
        "venue_quote"
      );
      venueMs = Date.now() - venueStartedAt;
      const premiumPricing = resolvePremiumPricing({
        tierName,
        protectedNotional,
        hedgePremium: new Decimal(quote.premium)
      });
      const pricingBreakdown = {
        hedgePremiumUsd: premiumPricing.hedgePremiumUsd.toFixed(10),
        markupPct: premiumPricing.markupPct.toFixed(6),
        markupUsd: premiumPricing.markupUsd.toFixed(10),
        premiumFloorUsdAbsolute: premiumPricing.premiumFloorUsdAbsolute.toFixed(10),
        premiumFloorUsdFromBps: premiumPricing.premiumFloorUsdFromBps.toFixed(10),
        premiumFloorBps: premiumPricing.premiumFloorBps.toFixed(2),
        premiumFloorUsd: premiumPricing.premiumFloorUsd.toFixed(10),
        clientPremiumUsd: premiumPricing.clientPremiumUsd.toFixed(10),
        method: premiumPricing.method
      };
      await insertVenueQuote(pool, {
        ...quote,
        details: {
          ...(quote.details || {}),
          pricingBreakdown,
          lockContext: {
            requestedInstrumentId: quoteInstrumentId,
            quoteInstrumentId: quote.instrumentId,
            marketId,
            tierName,
            drawdownFloorPct: drawdownFloorPct.toFixed(6),
            protectedNotional: protectedNotional.toFixed(10),
            foxifyExposureNotional: exposureNotional.toFixed(10),
            entryPrice: entryAnchorPrice.toFixed(10),
            entryAnchorPrice: entryAnchorPrice.toFixed(10),
            entryPriceSource: "reference_snapshot_quote",
            entryPriceTimestamp: snapshot.priceTimestamp,
            entryInputPrice: entryInputPrice ? entryInputPrice.toFixed(10) : null,
            protectionType,
            optionType,
            triggerPrice: triggerPrice.toFixed(10),
            triggerLabel,
            floorPrice: triggerPrice.toFixed(10),
            ...pricingBreakdown
          }
        }
      });
      const clientQuote = sanitizeQuoteForClient({
        ...quote,
        premium: Number(premiumPricing.clientPremiumUsd.toFixed(4)),
      });
      return {
        status: "ok",
        protectionType,
        tierName,
        drawdownFloorPct: drawdownFloorPct.toFixed(6),
        triggerPrice: triggerPrice.toFixed(10),
        triggerLabel,
        floorPrice: triggerPrice.toFixed(10),
        quote: clientQuote,
        entrySnapshot: {
          price: snapshot.price.toFixed(10),
          marketId: snapshot.marketId,
          source: snapshot.priceSource,
          timestamp: snapshot.priceTimestamp,
          requestId: snapshot.requestId
        },
        entryInputPrice: entryInputPrice ? entryInputPrice.toFixed(10) : null,
        limits: {
          maxProtectionNotionalUsdc: maxProtection.toFixed(2),
          maxDailyProtectedNotionalUsdc: maxDailyProtection.toFixed(2),
          dailyUsedUsdc: dailyUsed.toFixed(2),
          projectedDailyUsdc: projectedDaily.toFixed(2),
          dailyCapExceededOnActivate: projectedDaily.gt(maxDailyProtection)
        },
        diagnostics: {
          requestId,
          timingsMs: {
            price: priceMs,
            venue: venueMs,
            total: Date.now() - quoteStartedAt
          }
        }
      };
    } catch (error: any) {
      const message = String(error?.message || "quote_generation_failed");
      const isTimeout = message.includes("timeout") || message.includes("AbortError");
      const isStorageFailure =
        message.includes("postgres") || message.includes("ECONN") || message.includes("pool") || message.includes("db");
      reply.code(isTimeout ? 504 : isStorageFailure ? 503 : 502);
      return {
        status: "error",
        reason: isStorageFailure ? "storage_unavailable" : "quote_generation_failed",
        message: isStorageFailure
          ? "Storage temporarily unavailable, please retry."
          : "Unable to generate a venue quote right now. Please retry.",
        detail: message,
        diagnostics: {
          requestId,
          stage: "venue_quote",
          timingsMs: {
            price: priceMs,
            total: Date.now() - quoteStartedAt
          }
        }
      };
    }
  });

  app.post("/pilot/protections/activate", async (req, reply) => {
    if (!enforcePilotWindow(reply)) return;
    const body = req.body as {
      protectedNotional?: number;
      foxifyExposureNotional?: number;
      instrumentId?: string;
      marketId?: string;
      expiryAt?: string;
      tenorDays?: number;
      autoRenew?: boolean;
      renewWindowMinutes?: number;
      clientOrderId?: string;
      tierName?: string;
      drawdownFloorPct?: number;
      protectionType?: "long" | "short";
      entryPrice?: number;
      quoteId?: string;
    };
    if (!body.quoteId) {
      reply.code(400);
      return { status: "error", reason: "missing_quote_id" };
    }
    const protectedNotional = parsePositiveDecimal(body.protectedNotional);
    const exposureNotional = parsePositiveDecimal(body.foxifyExposureNotional);
    const entryInputPrice = parsePositiveDecimal(body.entryPrice);
    if (!protectedNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_protected_notional" };
    }
    if (!exposureNotional) {
      reply.code(400);
      return { status: "error", reason: "invalid_exposure_notional" };
    }
    const maxProtection = new Decimal(pilotConfig.maxProtectionNotionalUsdc);
    const maxDailyProtection = new Decimal(pilotConfig.maxDailyProtectedNotionalUsdc);
    if (protectedNotional.gt(maxProtection)) {
      reply.code(400);
      return {
        status: "error",
        reason: "protection_notional_cap_exceeded",
        capUsdc: maxProtection.toFixed(2)
      };
    }
    if (protectedNotional.gt(exposureNotional)) {
      reply.code(400);
      return { status: "error", reason: "protected_notional_exceeds_exposure" };
    }
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    if (!(await requireTermsAcceptance(reply, userHash))) return;
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const marketId = pilotConfig.referenceMarketId;
    const protectionType = normalizeProtectionType(body.protectionType);
    const optionType = protectionType === "short" ? "C" : "P";
    const triggerLabel = protectionType === "short" ? "ceiling_price" : "floor_price";
    const instrumentId = body.instrumentId || `${marketId}-7D-${optionType}`;
    const tierName = normalizeTierName(body.tierName);
    const drawdownFloorPct = resolveDrawdownFloorPct({
      tierName,
      drawdownFloorPct: body.drawdownFloorPct
    });
    const tenorDays = resolveExpiryDays({ tierName, requestedDays: body.tenorDays });
    const expiryAt = new Date(Date.now() + tenorDays * 86400000).toISOString();
    const requestId = pilotConfig.nextRequestId();
    const client = await pool.connect();
    let capUsedUsdc: string | null = null;
    let capProjectedUsdc: string | null = null;
    let transactionOpen = false;
    let transactionCommitted = false;
    let activationProtectionId: string | null = null;
    let quoteEntryAnchorPrice: Decimal | null = null;
    let triggerPrice: Decimal | null = null;
    let quoteEntryInputPrice: string | null = null;
    let quoteEntryPriceSource = "reference_snapshot_quote";
    let quoteEntryPriceTimestamp: string | null = null;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const lockedQuote = await getVenueQuoteByQuoteIdForUpdate(client, body.quoteId);
      if (!lockedQuote) {
        throw new Error("quote_not_found");
      }
      if (lockedQuote.consumedByProtectionId) {
        const existing = await getProtection(client, lockedQuote.consumedByProtectionId);
        if (existing && existing.userHash === userHash.userHash) {
          await client.query("COMMIT");
          transactionOpen = false;
          if (existing.status === "activation_failed") {
            reply.code(409);
            return {
              status: "error",
              reason: "activation_previously_failed",
              message: "Previous activation failed. Please request a fresh quote and retry.",
              protection: sanitizeProtectionForTrader(existing as unknown as Record<string, unknown>)
            };
          }
          if (existing.status === "pending_activation") {
            reply.code(409);
            return {
              status: "error",
              reason: "activation_in_progress",
              message: "Activation is still processing. Refresh protection status and retry shortly.",
              protection: sanitizeProtectionForTrader(existing as unknown as Record<string, unknown>)
            };
          }
          const replayCoverageRatio =
            existing.metadata && typeof existing.metadata["coverageRatio"] === "string"
              ? String(existing.metadata["coverageRatio"])
              : null;
          const replayQuote = sanitizeQuoteForClient({
            ...lockedQuote,
            premium: Number(new Decimal(existing.premium || lockedQuote.premium).toFixed(4))
          });
          return {
            status: "ok",
            protection: sanitizeProtectionForTrader(existing as unknown as Record<string, unknown>),
            coverageRatio: replayCoverageRatio,
            quote: replayQuote,
            idempotentReplay: true
          };
        }
        throw new Error("quote_already_consumed");
      }
      if (Date.now() > Date.parse(lockedQuote.expiresAt)) {
        throw new Error("quote_expired");
      }
      const lockContext = (lockedQuote.details?.lockContext || {}) as Record<string, unknown>;
      const requestedInstrumentId = String(lockContext.requestedInstrumentId || instrumentId);
      if (requestedInstrumentId !== instrumentId) {
        throw new Error("quote_mismatch_instrument");
      }
      const contextProtected = parsePositiveDecimal(lockContext.protectedNotional);
      const contextExposure = parsePositiveDecimal(lockContext.foxifyExposureNotional);
      const contextEntryAnchor = parsePositiveDecimal(lockContext.entryAnchorPrice ?? lockContext.entryPrice);
      const contextDrawdown = parsePositiveDecimal(lockContext.drawdownFloorPct);
      const contextProtectionType = normalizeProtectionType(
        String(lockContext.protectionType || inferProtectionTypeFromInstrument(requestedInstrumentId))
      );
      const computedTriggerFromContext = contextEntryAnchor && contextDrawdown
        ? computeTriggerPrice(contextEntryAnchor, contextDrawdown, contextProtectionType)
        : null;
      const contextTrigger = parsePositiveDecimal(lockContext.triggerPrice ?? lockContext.floorPrice);
      const quantity = contextEntryAnchor
        ? protectedNotional.div(contextEntryAnchor).toDecimalPlaces(8).toNumber()
        : 0;
      const quantityDeltaPct =
        quantity > 0
          ? new Decimal(lockedQuote.quantity).minus(quantity).abs().div(new Decimal(quantity))
          : new Decimal(0);
      if (quantityDeltaPct.gt(new Decimal(pilotConfig.fullCoverageTolerancePct))) {
        throw new Error("quote_mismatch_quantity");
      }
      if (contextProtectionType !== protectionType) {
        throw new Error("quote_mismatch_type");
      }
      if (
        String(lockContext.marketId || marketId) !== marketId ||
        String(lockContext.tierName || tierName) !== tierName ||
        !contextProtected ||
        !contextExposure ||
        !contextEntryAnchor ||
        !contextDrawdown ||
        !contextTrigger ||
        !computedTriggerFromContext ||
        contextProtected.minus(protectedNotional).abs().gt(new Decimal("0.000001")) ||
        contextExposure.minus(exposureNotional).abs().gt(new Decimal("0.000001")) ||
        contextDrawdown.minus(drawdownFloorPct).abs().gt(new Decimal("0.000001")) ||
        contextTrigger.minus(computedTriggerFromContext).abs().gt(new Decimal("0.000001"))
      ) {
        throw new Error("quote_mismatch_context");
      }
      quoteEntryAnchorPrice = contextEntryAnchor;
      triggerPrice = computedTriggerFromContext;
      quoteEntryInputPrice =
        typeof lockContext.entryInputPrice === "string" ? String(lockContext.entryInputPrice) : null;
      quoteEntryPriceSource =
        typeof lockContext.entryPriceSource === "string"
          ? String(lockContext.entryPriceSource)
          : "reference_snapshot_quote";
      quoteEntryPriceTimestamp =
        typeof lockContext.entryPriceTimestamp === "string"
          ? String(lockContext.entryPriceTimestamp)
          : null;
      const capReservation = await reserveDailyActivationCapacity(client, {
        userHash: userHash.userHash,
        dayStartIso: dayStart.toISOString(),
        protectedNotional: protectedNotional.toFixed(10),
        maxDailyNotional: maxDailyProtection.toFixed(10)
      });
      if (!capReservation.ok) {
        const capError = new Error("daily_notional_cap_exceeded");
        const usedNow = new Decimal(capReservation.usedNow);
        capUsedUsdc = usedNow.toFixed(2);
        capProjectedUsdc = usedNow.plus(protectedNotional).toFixed(2);
        (capError as any).usedUsdc = capUsedUsdc;
        (capError as any).projectedUsdc = capProjectedUsdc;
        throw capError;
      }
      const usedAfter = new Decimal(capReservation.usedAfter);
      capProjectedUsdc = usedAfter.toFixed(2);
      capUsedUsdc = usedAfter.minus(protectedNotional).toFixed(2);
      const protection = await insertProtection(client, {
        userHash: userHash.userHash,
        hashVersion: userHash.hashVersion,
        status: "pending_activation",
        tierName,
        drawdownFloorPct: drawdownFloorPct.toFixed(6),
        marketId,
        protectedNotional: protectedNotional.toFixed(10),
        foxifyExposureNotional: exposureNotional.toFixed(10),
        expiryAt,
        autoRenew: parseBoolean(body.autoRenew, false),
        renewWindowMinutes: resolveRenewWindowMinutes({
          tierName,
          requestedMinutes: body.renewWindowMinutes
        }),
        metadata: {
          mode: "pilot",
          venueMode: pilotConfig.venueMode,
          tierName,
          drawdownFloorPct: drawdownFloorPct.toFixed(6),
          protectionType,
          optionType
        }
      });
      activationProtectionId = protection.id;
      const consumed = await consumeVenueQuote(client, lockedQuote.id, protection.id);
      if (!consumed) {
        throw new Error("quote_already_consumed");
      }
      const contextHedgePremium = parsePositiveDecimal(lockContext.hedgePremiumUsd) || new Decimal(lockedQuote.premium);
      const contextMarkupPct = parsePositiveDecimal(lockContext.markupPct);
      const contextMarkupUsd = parsePositiveDecimal(lockContext.markupUsd);
      const contextFloorUsd = parsePositiveDecimal(lockContext.premiumFloorUsd);
      const contextFloorUsdAbsolute = parsePositiveDecimal(lockContext.premiumFloorUsdAbsolute);
      const contextFloorUsdFromBps = parsePositiveDecimal(lockContext.premiumFloorUsdFromBps);
      const contextFloorBps = parsePositiveDecimal(lockContext.premiumFloorBps);
      const contextClientPremium = parsePositiveDecimal(lockContext.clientPremiumUsd);
      const fallbackPremiumPricing = resolvePremiumPricing({
        tierName,
        protectedNotional,
        hedgePremium: contextHedgePremium
      });
      const premiumPricing = {
        hedgePremiumUsd: contextHedgePremium,
        markupPct: contextMarkupPct || fallbackPremiumPricing.markupPct,
        markupUsd: contextMarkupUsd || fallbackPremiumPricing.markupUsd,
        premiumFloorUsdAbsolute: contextFloorUsdAbsolute || fallbackPremiumPricing.premiumFloorUsdAbsolute,
        premiumFloorUsdFromBps: contextFloorUsdFromBps || fallbackPremiumPricing.premiumFloorUsdFromBps,
        premiumFloorBps: contextFloorBps || fallbackPremiumPricing.premiumFloorBps,
        premiumFloorUsd: contextFloorUsd || fallbackPremiumPricing.premiumFloorUsd,
        clientPremiumUsd: contextClientPremium || fallbackPremiumPricing.clientPremiumUsd,
        method: (() => {
          const rawMethod = String(lockContext.method || fallbackPremiumPricing.method);
          if (rawMethod === "floor_usd") return "floor_usd";
          if (rawMethod === "floor_bps") return "floor_bps";
          return "markup";
        })()
      } as const;
      await client.query("COMMIT");
      transactionOpen = false;
      transactionCommitted = true;

      const snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.referencePriceUrl,
          fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
          requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
          requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
        },
        {
          marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      const execution = await withTimeout(
        venue.execute(lockedQuote),
        pilotConfig.venueExecuteTimeoutMs,
        "venue_execute"
      );
      if (execution.status !== "success") {
        throw new Error("execution_failed");
      }
      const coverageRatio =
        quantity > 0 ? new Decimal(execution.quantity).div(new Decimal(quantity)) : new Decimal(0);
      const threshold = new Decimal(1).minus(new Decimal(pilotConfig.fullCoverageTolerancePct));
      if (
        (pilotConfig.requireFullCoverage || pilotConfig.requireFullExecutionFill) &&
        coverageRatio.lt(threshold)
      ) {
        throw new Error("full_coverage_not_met");
      }
      await insertPriceSnapshot(pool, {
        protectionId: protection.id,
        snapshotType: "entry",
        price: snapshot.price.toFixed(10),
        marketId: snapshot.marketId,
        priceSource: snapshot.priceSource,
        priceSourceDetail: snapshot.priceSourceDetail,
        endpointVersion: snapshot.endpointVersion,
        requestId: snapshot.requestId,
        priceTimestamp: snapshot.priceTimestamp
      });
      await insertVenueExecution(pool, protection.id, execution);
      await insertLedgerEntry(pool, {
        id: `${protection.id}:premium_due`,
        protectionId: protection.id,
        entryType: "premium_due",
        amount: premiumPricing.clientPremiumUsd.toFixed(10),
        reference: execution.externalOrderId
      });
      if (!quoteEntryAnchorPrice || !triggerPrice) {
        throw new Error("quote_mismatch_context");
      }
      const updated = await patchProtection(pool, protection.id, {
        status: "active",
        entry_price: quoteEntryAnchorPrice.toFixed(10),
        entry_price_source: quoteEntryPriceSource,
        entry_price_timestamp: quoteEntryPriceTimestamp || snapshot.priceTimestamp,
        floor_price: triggerPrice.toFixed(10),
        venue: execution.venue,
        instrument_id: execution.instrumentId,
        side: execution.side,
        size: new Decimal(execution.quantity).toFixed(10),
        execution_price: new Decimal(execution.executionPrice).toFixed(10),
        premium: premiumPricing.clientPremiumUsd.toFixed(10),
        executed_at: execution.executedAt,
        external_order_id: execution.externalOrderId,
        external_execution_id: execution.externalExecutionId,
        metadata: {
          ...(protection.metadata || {}),
          quoteId: lockedQuote.quoteId,
          rfqId: lockedQuote.rfqId || null,
          tierName,
          protectionType,
          optionType,
          triggerLabel,
          drawdownFloorPct: drawdownFloorPct.toFixed(6),
          triggerPrice: triggerPrice.toFixed(10),
          floorPrice: triggerPrice.toFixed(10),
          coverageRatio: coverageRatio.toFixed(6),
          hedgePremiumUsd: premiumPricing.hedgePremiumUsd.toFixed(10),
          markupPct: premiumPricing.markupPct.toFixed(6),
          markupUsd: premiumPricing.markupUsd.toFixed(10),
          premiumFloorUsdAbsolute: premiumPricing.premiumFloorUsdAbsolute.toFixed(10),
          premiumFloorUsdFromBps: premiumPricing.premiumFloorUsdFromBps.toFixed(10),
          premiumFloorBps: premiumPricing.premiumFloorBps.toFixed(2),
          premiumFloorUsd: premiumPricing.premiumFloorUsd.toFixed(10),
          clientPremiumUsd: premiumPricing.clientPremiumUsd.toFixed(10),
          premiumMethod: premiumPricing.method,
          entryAnchorPrice: quoteEntryAnchorPrice.toFixed(10),
          entryAnchorSource: quoteEntryPriceSource,
          entryAnchorTimestamp: quoteEntryPriceTimestamp || snapshot.priceTimestamp,
          entryInputPrice:
            entryInputPrice?.toFixed(10) ||
            quoteEntryInputPrice,
          entrySnapshotPrice: snapshot.price.toFixed(10),
          entrySnapshotSource: snapshot.priceSource,
          entrySnapshotTimestamp: snapshot.priceTimestamp
        }
      });
      const activatedQuote = sanitizeQuoteForClient({
        ...lockedQuote,
        premium: Number(premiumPricing.clientPremiumUsd.toFixed(4)),
      });
      return {
        status: "ok",
        protection: updated
          ? sanitizeProtectionForTrader(updated as unknown as Record<string, unknown>)
          : null,
        coverageRatio: coverageRatio.toFixed(6),
        quote: activatedQuote
      };
    } catch (error: any) {
      if (transactionOpen) {
        await client.query("ROLLBACK");
        transactionOpen = false;
      }
      const errMsg = String(error?.message || "");
      if (transactionCommitted && activationProtectionId) {
        try {
          const compensationClient = await pool.connect();
          let compensationTxOpen = false;
          try {
            await compensationClient.query("BEGIN");
            compensationTxOpen = true;
            const locked = await getProtectionForUpdate(compensationClient, activationProtectionId);
            if (locked?.status === "pending_activation") {
              await patchProtection(compensationClient, activationProtectionId, {
                status: "activation_failed",
                metadata: {
                  ...(locked.metadata || {}),
                  activationFailure: {
                    at: new Date().toISOString(),
                    reason: errMsg || "activation_failed",
                    requestId
                  }
                }
              });
              await releaseDailyActivationCapacity(compensationClient, {
                userHash: userHash.userHash,
                dayStartIso: dayStart.toISOString(),
                protectedNotional: protectedNotional.toFixed(10)
              });
            }
            await compensationClient.query("COMMIT");
            compensationTxOpen = false;
          } catch {
            if (compensationTxOpen) {
              await compensationClient.query("ROLLBACK");
            }
          } finally {
            compensationClient.release();
          }
        } catch {
          // swallow compensation errors and return original activation failure
        }
      }
      let reason = "activation_failed";
      if (errMsg.includes("price_unavailable")) {
        reason = "price_unavailable";
      } else if (
        [
          "quote_not_found",
          "quote_expired",
          "quote_already_consumed",
          "quote_mismatch_instrument",
          "quote_mismatch_type",
          "quote_mismatch_quantity",
          "quote_mismatch_context",
          "activation_in_progress",
          "activation_previously_failed",
          "full_coverage_not_met",
          "storage_unavailable"
        ].includes(errMsg)
      ) {
        reason = errMsg;
      } else if (
        errMsg === "protection_notional_cap_exceeded" ||
        errMsg === "daily_notional_cap_exceeded" ||
        errMsg === "user_hash_secret_missing" ||
        errMsg === "venue_execute_timeout"
      ) {
        reason = errMsg;
      } else if (
        errMsg.includes("postgres") ||
        errMsg.includes("ECONN") ||
        errMsg.includes("pool") ||
        errMsg.includes("connection terminated")
      ) {
        reason = "storage_unavailable";
      } else {
        reason = mapVenueFailureReason(error);
      }
      if (reason === "price_unavailable") {
        reply.code(503);
      } else if (reason === "storage_unavailable") {
        reply.code(503);
      } else if (reason === "venue_execute_timeout") {
        reply.code(504);
      } else if (reason === "user_hash_secret_missing") {
        reply.code(500);
      } else if (reason === "quote_not_found") {
        reply.code(404);
      } else if (reason === "quote_already_consumed") {
        reply.code(409);
      } else {
        reply.code(400);
      }
      return {
        status: "error",
        reason,
        message:
          reason === "price_unavailable"
            ? "Price temporarily unavailable, please retry."
            : reason === "storage_unavailable"
              ? "Storage temporarily unavailable, please retry."
            : reason === "daily_notional_cap_exceeded"
              ? "Daily protection limit reached for pilot operations. Try again next UTC day."
              : reason === "protection_notional_cap_exceeded"
                ? `Protection amount exceeds pilot cap (${new Decimal(pilotConfig.maxProtectionNotionalUsdc).toFixed(2)} USDC).`
            : reason === "quote_already_consumed"
              ? "Quote has already been activated. Refresh protections before retrying."
            : reason === "venue_execute_timeout"
              ? "Venue execution timed out. Please request a fresh quote."
            : reason === "quote_expired"
              ? "Quote expired. Please request a new quote."
              : reason.startsWith("quote_mismatch")
                ? "Quote does not match activation parameters. Please request a new quote."
            : "Protection activation failed.",
        ...(reason === "daily_notional_cap_exceeded"
          ? {
              capUsdc: maxDailyProtection.toFixed(2),
              usedUsdc: (error as any)?.usedUsdc || capUsedUsdc,
              projectedUsdc: (error as any)?.projectedUsdc || capProjectedUsdc
            }
          : {})
      };
    } finally {
      client.release();
    }
  });

  app.get("/pilot/protections", async (req, reply) => {
    const query = req.query as { limit?: string };
    let userHash: { userHash: string; hashVersion: number };
    try {
      userHash = resolveTenantScopeHash();
    } catch (error: any) {
      const reason = String(error?.message || "server_config_error");
      reply.code(reason === "user_hash_secret_missing" ? 500 : 400);
      return { status: "error", reason };
    }
    try {
      const protections = await listProtectionsByUserHash(pool, userHash.userHash, {
        limit: Number(query.limit || 20)
      });
      return {
        status: "ok",
        protections: protections.map((item) =>
          sanitizeProtectionForTrader(item as unknown as Record<string, unknown>)
        )
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "list_protections_failed")
      };
    }
  });

  app.get("/pilot/protections/:id/monitor", async (req, reply) => {
    const params = req.params as { id: string };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    const requestId = pilotConfig.nextRequestId();
    let snapshot: PriceSnapshotOutput;
    try {
      snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.referencePriceUrl,
          fallbackUrl: pilotConfig.singlePriceSource ? "" : pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs,
          requestRetryAttempts: pilotConfig.priceRequestRetryAttempts,
          requestRetryDelayMs: pilotConfig.priceRequestRetryDelayMs
        },
        {
          marketId: protection.marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String(error?.message || "monitor_price_unavailable")
      };
    }
    const protectionType = resolveProtectionTypeFromRecord(protection);
    const entryPrice = parsePositiveDecimal(protection.entryPrice) || snapshot.price;
    const drawdownFloorPct = parsePositiveDecimal(protection.drawdownFloorPct) || new Decimal("0.2");
    const triggerPrice =
      parsePositiveDecimal(protection.floorPrice) ||
      computeTriggerPrice(entryPrice, drawdownFloorPct, protectionType);
    const referencePrice = snapshot.price;
    const distanceToTriggerPct = referencePrice.gt(0)
      ? protectionType === "short"
        ? triggerPrice.minus(referencePrice).div(referencePrice).mul(100)
        : referencePrice.minus(triggerPrice).div(referencePrice).mul(100)
      : new Decimal(0);
    const protectedNotional = parsePositiveDecimal(protection.protectedNotional) || new Decimal(0);
    const estimatedTriggerValue = protectedNotional.mul(drawdownFloorPct);
    const quantity = parsePositiveDecimal(protection.size)?.toNumber() || 0;
    const metadataHedgePremium =
      protection.metadata && typeof protection.metadata["hedgePremiumUsd"] === "string"
        ? parsePositiveDecimal(protection.metadata["hedgePremiumUsd"])
        : null;
    let optionMarkUsd = metadataHedgePremium?.toNumber() || parsePositiveDecimal(protection.premium)?.toNumber() || 0;
    let markSource = metadataHedgePremium ? "stored_hedge_premium" : "stored_premium";
    let markDetails: Record<string, unknown> | null = null;
    if (protection.instrumentId && quantity > 0) {
      try {
        const mark = await withTimeout(
          venue.getMark({
            instrumentId: protection.instrumentId,
            quantity
          }),
          pilotConfig.venueMarkTimeoutMs,
          "venue_mark"
        );
        optionMarkUsd = mark.markPremium;
        markSource = mark.source;
        markDetails = mark.details || null;
      } catch (error: any) {
        markDetails = { error: String(error?.message || "mark_unavailable") };
      }
    }
    return {
      status: "ok",
      monitor: {
        protectionId: protection.id,
        status: protection.status,
        protectionType,
        referencePrice: referencePrice.toFixed(10),
        referenceSource: snapshot.priceSource,
        referenceTimestamp: snapshot.priceTimestamp,
        triggerPrice: triggerPrice.toFixed(10),
        distanceToTriggerPct: distanceToTriggerPct.toFixed(4),
        optionMarkUsd: new Decimal(optionMarkUsd).toFixed(10),
        markSource,
        markDetails,
        estimatedTriggerValue: estimatedTriggerValue.toFixed(10),
        asOf: new Date().toISOString()
      }
    };
  });

  app.get("/pilot/protections/:id", async (req, reply) => {
    const params = req.params as { id: string };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return {
      status: "ok",
      protection: sanitizeProtectionForTrader(protection as unknown as Record<string, unknown>)
    };
  });

  app.get("/pilot/protections/:id/proof", async (req, reply) => {
    const allowed = await requireProofAccess(req, reply);
    if (!allowed) return;
    const params = req.params as { id: string };
    const payload = await getEssentialProofPayload(pool, params.id);
    if (!payload) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", proof: payload };
  });

  app.get("/pilot/protections/export", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const scopedUserHash = resolveScopedUserHash(reply);
    if (!scopedUserHash) return;
    const query = req.query as { format?: string; limit?: string; offset?: string };
    const limit = parsePositiveInt(query.limit, 200, 1000);
    const offset = parseNonNegativeInt(query.offset, 0);
    try {
      const [protections, total] = await Promise.all([
        listProtectionsByUserHash(pool, scopedUserHash, { limit, offset }),
        countProtectionsByUserHash(pool, scopedUserHash)
      ]);
      const rows = protections.map((item) => ({
        protection_id: item.id,
        status: item.status,
        tier_name: item.tierName,
        drawdown_floor_pct: item.drawdownFloorPct,
        created_at: item.createdAt,
        expiry_at: item.expiryAt,
        market_id: item.marketId,
        entry_price: item.entryPrice,
        floor_price: item.floorPrice,
        expiry_price: item.expiryPrice,
        protected_notional: item.protectedNotional,
        premium: item.premium,
        payout_due_amount: item.payoutDueAmount,
        payout_settled_amount: item.payoutSettledAmount,
        venue: item.venue,
        instrument_id: item.instrumentId,
        external_order_id: item.externalOrderId,
        external_execution_id: item.externalExecutionId
      }));
      if (String(query.format || "json").toLowerCase() === "csv") {
        reply.header("Content-Type", "text/csv");
        return toCsv(rows);
      }
      return {
        status: "ok",
        rows,
        pagination: {
          total,
          limit,
          offset,
          nextOffset: offset + rows.length < total ? offset + rows.length : null
        }
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "protections_export_failed")
      };
    }
  });

  app.get("/pilot/admin/reconciliation/export", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const scopedUserHash = resolveScopedUserHash(reply);
    if (!scopedUserHash) return;
    const query = req.query as { format?: string; limit?: string; offset?: string };
    const limit = parsePositiveInt(query.limit, 200, 1000);
    const offset = parseNonNegativeInt(query.offset, 0);
    try {
      const [protections, total] = await Promise.all([
        listProtectionsByUserHash(pool, scopedUserHash, { limit, offset }),
        countProtectionsByUserHash(pool, scopedUserHash)
      ]);
      const rows = await Promise.all(
        protections.map(async (item) => {
          const ledger = await listLedgerForProtection(pool, item.id);
          const sumEntryType = (entryType: string): Decimal =>
            ledger
              .filter((entry) => entry.entryType === entryType)
              .reduce((acc, entry) => acc.plus(parseDecimalValue(entry.amount) || new Decimal(0)), new Decimal(0));
          const latestReferenceFor = (entryType: string): string | null => {
            const filtered = ledger.filter((entry) => entry.entryType === entryType);
            if (!filtered.length) return null;
            return filtered[filtered.length - 1]?.reference || null;
          };
          const premiumDueTotal = sumEntryType("premium_due");
          const premiumSettledTotal = sumEntryType("premium_settled");
          const payoutDueTotal = sumEntryType("payout_due");
          const payoutSettledTotal = sumEntryType("payout_settled");
          const hedgePremium =
            parseDecimalValue(item.metadata?.hedgePremiumUsd) ||
            parseDecimalValue(item.metadata?.rawHedgePremiumUsd);
          const clientPremium = parseDecimalValue(item.premium);
          const margin = clientPremium && hedgePremium ? clientPremium.minus(hedgePremium) : null;
          return {
            protection_id: item.id,
            status: item.status,
            created_at: item.createdAt,
            expiry_at: item.expiryAt,
            market_id: item.marketId,
            protection_type:
              typeof item.metadata?.protectionType === "string" ? String(item.metadata.protectionType) : "long",
            tier_name: item.tierName,
            drawdown_floor_pct: item.drawdownFloorPct,
            protected_notional: item.protectedNotional,
            foxify_exposure_notional: item.foxifyExposureNotional,
            entry_price: item.entryPrice,
            entry_price_source: item.entryPriceSource,
            entry_price_timestamp: item.entryPriceTimestamp,
            trigger_price: item.floorPrice,
            expiry_price: item.expiryPrice,
            expiry_price_source: item.expiryPriceSource,
            expiry_price_timestamp: item.expiryPriceTimestamp,
            venue: item.venue,
            instrument_id: item.instrumentId,
            side: item.side,
            size: item.size,
            execution_price: item.executionPrice,
            quote_id: typeof item.metadata?.quoteId === "string" ? String(item.metadata.quoteId) : null,
            rfq_id: typeof item.metadata?.rfqId === "string" ? String(item.metadata.rfqId) : null,
            external_order_id: item.externalOrderId,
            external_execution_id: item.externalExecutionId,
            client_premium_usdc: clientPremium ? clientPremium.toFixed(10) : null,
            hedge_premium_usdc: hedgePremium ? hedgePremium.toFixed(10) : null,
            trade_margin_usdc: margin ? margin.toFixed(10) : null,
            premium_due_total_usdc: premiumDueTotal.toFixed(10),
            premium_settled_total_usdc: premiumSettledTotal.toFixed(10),
            premium_settled_reference: latestReferenceFor("premium_settled"),
            premium_outstanding_usdc: premiumDueTotal.minus(premiumSettledTotal).toFixed(10),
            payout_due_total_usdc: payoutDueTotal.toFixed(10),
            payout_settled_total_usdc: payoutSettledTotal.toFixed(10),
            payout_settled_reference: latestReferenceFor("payout_settled"),
            payout_outstanding_usdc: payoutDueTotal.minus(payoutSettledTotal).toFixed(10),
            payout_tx_ref: item.payoutTxRef,
            payout_settled_at: item.payoutSettledAt,
            ledger_entry_count: ledger.length
          };
        })
      );
      if (String(query.format || "json").toLowerCase() === "csv") {
        reply.header("Content-Type", "text/csv");
        return toCsv(rows);
      }
      return {
        status: "ok",
        rows,
        pagination: {
          total,
          limit,
          offset,
          nextOffset: offset + rows.length < total ? offset + rows.length : null
        }
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "reconciliation_export_failed")
      };
    }
  });

  app.post("/pilot/protections/:id/renewal-decision", async (req, reply) => {
    const params = req.params as { id: string };
    const body = req.body as { decision?: "renew" | "expire" };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (body.decision === "expire") {
      const updated = await patchProtection(pool, params.id, { status: "cancelled" });
      return {
        status: "ok",
        protection: updated
          ? sanitizeProtectionForTrader(updated as unknown as Record<string, unknown>)
          : null
      };
    }
    if (body.decision === "renew") {
      const now = new Date();
      const previousExpiry = new Date(protection.expiryAt).getTime();
      const nextExpiry = Number.isFinite(previousExpiry)
        ? new Date(previousExpiry + 7 * 86400000)
        : new Date(now.getTime() + 7 * 86400000);
      const cloned = await insertProtection(pool, {
        userHash: protection.userHash,
        hashVersion: protection.hashVersion,
        status: "awaiting_renew_decision",
        tierName: protection.tierName,
        drawdownFloorPct: protection.drawdownFloorPct,
        marketId: protection.marketId,
        protectedNotional: protection.protectedNotional,
        foxifyExposureNotional: protection.foxifyExposureNotional,
        expiryAt: nextExpiry.toISOString(),
        autoRenew: protection.autoRenew,
        renewWindowMinutes: protection.renewWindowMinutes,
        metadata: { renewalOf: protection.id }
      });
      return {
        status: "ok",
        protection: sanitizeProtectionForTrader(cloned as unknown as Record<string, unknown>)
      };
    }
    reply.code(400);
    return { status: "error", reason: "invalid_decision" };
  });

  app.get("/pilot/admin/metrics", async (req, reply) => {
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const scopedUserHash = resolveScopedUserHash(reply);
    if (!scopedUserHash) return;
    try {
      const metrics = await getPilotAdminMetrics(pool, {
        startingReserveUsdc: pilotConfig.startingReserveUsdc,
        userHash: scopedUserHash
      });
      return { status: "ok", metrics };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "admin_metrics_failed")
      };
    }
  });

  app.post("/pilot/admin/protections/:id/premium-settled", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const scopedUserHash = resolveScopedUserHash(reply);
    if (!scopedUserHash) return;
    const body = req.body as { amount?: number; reference?: string };
    const client = await pool.connect();
    let txOpen = false;
    try {
      await client.query("BEGIN");
      txOpen = true;
      const protection = await getProtectionForUpdate(client, params.id);
      if (!protection) {
        await client.query("ROLLBACK");
        txOpen = false;
        reply.code(404);
        return { status: "error", reason: "not_found" };
      }
      if (protection.userHash !== scopedUserHash) {
        await client.query("ROLLBACK");
        txOpen = false;
        reply.code(404);
        return { status: "error", reason: "not_found" };
      }
      const existingLedger = await listLedgerForProtection(client, params.id);
      const existingPremiumSettlement = existingLedger.find((entry) => entry.entryType === "premium_settled");
      if (existingPremiumSettlement) {
        await client.query("COMMIT");
        txOpen = false;
        return {
          status: "ok",
          idempotentReplay: true,
          settledAmount: existingPremiumSettlement.amount,
          settledAt: existingPremiumSettlement.settledAt,
          reference: existingPremiumSettlement.reference
        };
      }
      const amount = Number(body.amount ?? protection.premium ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        await client.query("ROLLBACK");
        txOpen = false;
        reply.code(400);
        return { status: "error", reason: "invalid_amount" };
      }
      const inserted = await insertLedgerEntry(client, {
        id: `${params.id}:premium_settled`,
        protectionId: params.id,
        entryType: "premium_settled",
        amount: new Decimal(amount).toFixed(10),
        reference: body.reference || null,
        settledAt: new Date().toISOString()
      });
      if (!inserted) {
        await client.query("COMMIT");
        txOpen = false;
        const refreshedLedger = await listLedgerForProtection(pool, params.id);
        const refreshed = refreshedLedger.find((entry) => entry.entryType === "premium_settled");
        return {
          status: "ok",
          idempotentReplay: true,
          settledAmount: refreshed?.amount || new Decimal(amount).toFixed(10),
          settledAt: refreshed?.settledAt || null,
          reference: refreshed?.reference || body.reference || null
        };
      }
      await insertAdminAction(client, {
        protectionId: params.id,
        action: "premium_settled",
        actor: auth.actor,
        actorIp: auth.actorIp,
        details: { amount, reference: body.reference || null }
      });
      await client.query("COMMIT");
      txOpen = false;
      return { status: "ok" };
    } catch (error: any) {
      if (txOpen) await client.query("ROLLBACK");
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "premium_settlement_failed")
      };
    } finally {
      client.release();
    }
  });

  app.post("/pilot/admin/protections/:id/payout-settled", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const scopedUserHash = resolveScopedUserHash(reply);
    if (!scopedUserHash) return;
    const body = req.body as { amount?: number; payoutTxRef?: string };
    const client = await pool.connect();
    let txOpen = false;
    try {
      await client.query("BEGIN");
      txOpen = true;
      const protection = await getProtectionForUpdate(client, params.id);
      if (!protection) {
        await client.query("ROLLBACK");
        txOpen = false;
        reply.code(404);
        return { status: "error", reason: "not_found" };
      }
      if (protection.userHash !== scopedUserHash) {
        await client.query("ROLLBACK");
        txOpen = false;
        reply.code(404);
        return { status: "error", reason: "not_found" };
      }
      if (!protection.expiryPrice) {
        await client.query("ROLLBACK");
        txOpen = false;
        reply.code(409);
        return { status: "error", reason: "expiry_price_missing" };
      }
      const existingLedger = await listLedgerForProtection(client, params.id);
      const existingPayoutSettlement = existingLedger.find((entry) => entry.entryType === "payout_settled");
      if (existingPayoutSettlement) {
        await client.query("COMMIT");
        txOpen = false;
        return {
          status: "ok",
          idempotentReplay: true,
          settledAmount: existingPayoutSettlement.amount,
          settledAt: existingPayoutSettlement.settledAt,
          reference: existingPayoutSettlement.reference
        };
      }
      if (new Decimal(protection.payoutSettledAmount || "0").gt(0)) {
        await client.query("COMMIT");
        txOpen = false;
        return {
          status: "ok",
          idempotentReplay: true,
          settledAmount: String(protection.payoutSettledAmount),
          settledAt: protection.payoutSettledAt || null,
          reference: protection.payoutTxRef || null
        };
      }
      const amount = Number(body.amount ?? protection.payoutDueAmount ?? 0);
      if (!Number.isFinite(amount) || amount < 0) {
        await client.query("ROLLBACK");
        txOpen = false;
        reply.code(400);
        return { status: "error", reason: "invalid_amount" };
      }
      const payoutDue = new Decimal(protection.payoutDueAmount || "0");
      if (new Decimal(amount).gt(payoutDue)) {
        await client.query("ROLLBACK");
        txOpen = false;
        reply.code(400);
        return {
          status: "error",
          reason: "payout_settlement_exceeds_due",
          payoutDueAmount: payoutDue.toFixed(10)
        };
      }
      const inserted = await insertLedgerEntry(client, {
        id: `${params.id}:payout_settled`,
        protectionId: params.id,
        entryType: "payout_settled",
        amount: new Decimal(amount).toFixed(10),
        reference: body.payoutTxRef || null,
        settledAt: new Date().toISOString()
      });
      if (!inserted) {
        await client.query("COMMIT");
        txOpen = false;
        const refreshedLedger = await listLedgerForProtection(pool, params.id);
        const refreshed = refreshedLedger.find((entry) => entry.entryType === "payout_settled");
        return {
          status: "ok",
          idempotentReplay: true,
          settledAmount: refreshed?.amount || new Decimal(amount).toFixed(10),
          settledAt: refreshed?.settledAt || null,
          reference: refreshed?.reference || body.payoutTxRef || null
        };
      }
      await patchProtection(client, params.id, {
        payout_settled_amount: new Decimal(amount).toFixed(10),
        payout_settled_at: new Date().toISOString(),
        payout_tx_ref: body.payoutTxRef || null
      });
      await insertAdminAction(client, {
        protectionId: params.id,
        action: "payout_settled",
        actor: auth.actor,
        actorIp: auth.actorIp,
        details: { amount, payoutTxRef: body.payoutTxRef || null }
      });
      await client.query("COMMIT");
      txOpen = false;
      return { status: "ok" };
    } catch (error: any) {
      if (txOpen) await client.query("ROLLBACK");
      reply.code(503);
      return {
        status: "error",
        reason: "storage_unavailable",
        message: "Storage temporarily unavailable, please retry.",
        detail: String(error?.message || "payout_settlement_failed")
      };
    } finally {
      client.release();
    }
  });

  app.get("/pilot/admin/protections/:id/ledger", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const scopedUserHash = resolveScopedUserHash(reply);
    if (!scopedUserHash) return;
    const [protection, ledger] = await Promise.all([
      getProtection(pool, params.id),
      listLedgerForProtection(pool, params.id)
    ]);
    if (!protection || protection.userHash !== scopedUserHash) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", protection, ledger };
  });

  app.post("/pilot/internal/protections/:id/resolve-expiry", async (req, reply) => {
    const allowed = await requireInternalOrAdmin(req, reply);
    if (!allowed) return;
    const params = req.params as { id: string };
    await resolveAndPersistExpiry(params.id);
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", protection };
  });

  const retryEveryMs = Math.max(5000, Number(process.env.EXPIRY_RETRY_INTERVAL_MS || "30000"));
  const expiryInterval = setInterval(async () => {
    try {
      const pending = await pool.query(
        `
          SELECT id FROM pilot_protections
          WHERE status IN ('active', 'awaiting_expiry_price')
            AND expiry_at <= NOW()
            AND expiry_price IS NULL
          ORDER BY expiry_at ASC
          LIMIT 50
        `
      );
      for (const row of pending.rows) {
        await resolveAndPersistExpiry(String(row.id));
      }
    } catch {
      // intentionally swallow to avoid crashing scheduler loop
    }
  }, retryEveryMs);
  expiryInterval.unref?.();
};

