import { useEffect, useMemo, useRef, useState } from "react";
import {
  createDemoPositionSource,
  createFoxifyPositionSource
} from "./adapters/positionSource";
import { AuditDashboard } from "./components/AuditDashboard";
import {
  API_BASE,
  DATA_MODE,
  FOXIFY_APPROVED,
  FOXIFY_ENABLED,
  FOXIFY_POSITION_ENDPOINT,
  FOXIFY_PORTFOLIO_ENDPOINT
} from "./config";

type FundedLevel = {
  name: string;
  deposit_usdc: string;
  funding_usdc: string;
  points_target: string;
  profit_target_usdc: string;
  drawdown_limit_pct: string;
  fixed_price_usdc: string;
  expiry_days?: string;
  renew_window_minutes?: string;
  buffer_alert_pct?: string;
};

type Asset = "BTC";

type PortfolioPosition = {
  id: string;
  asset: Asset;
  side: "long" | "short";
  marginUsd: number;
  leverage: number;
  entryPrice: number;
};

type Portfolio = {
  tierName: string;
  positions: PortfolioPosition[];
};

type PortfolioValidation = {
  ok: boolean;
  error?: string;
  value?: Portfolio;
};

type RiskSummary = {
  equityUsdc: string;
  drawdownLimitUsdc: string;
  drawdownBufferUsdc: string;
  drawdownBufferPct: string;
};

const ASSETS: Asset[] = ["BTC"];
const parseNumberString = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return value;
  }
  return null;
};

const parseFundedLevels = (input: unknown): FundedLevel[] => {
  if (!input || typeof input !== "object") return [];
  const raw = (input as { levels?: unknown }).levels;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const level = entry as Record<string, unknown>;
      const name = typeof level.name === "string" ? level.name : null;
      const deposit_usdc = parseNumberString(level.deposit_usdc);
      const funding_usdc = parseNumberString(level.funding_usdc);
      const points_target = parseNumberString(level.points_target);
      const profit_target_usdc = parseNumberString(level.profit_target_usdc);
      const drawdown_limit_pct = parseNumberString(level.drawdown_limit_pct);
      const fixed_price_usdc = parseNumberString(level.fixed_price_usdc);
      if (
        !name ||
        !deposit_usdc ||
        !funding_usdc ||
        !points_target ||
        !profit_target_usdc ||
        !drawdown_limit_pct ||
        !fixed_price_usdc
      ) {
        return null;
      }
      const expiry_days = parseNumberString(level.expiry_days) ?? undefined;
      const renew_window_minutes = parseNumberString(level.renew_window_minutes) ?? undefined;
      const buffer_alert_pct = parseNumberString(level.buffer_alert_pct) ?? undefined;
      return {
        name,
        deposit_usdc,
        funding_usdc,
        points_target,
        profit_target_usdc,
        drawdown_limit_pct,
        fixed_price_usdc,
        expiry_days,
        renew_window_minutes,
        buffer_alert_pct
      } as FundedLevel;
    })
    .filter((item): item is FundedLevel => Boolean(item));
};

const formatSpotPrice = (value: number) =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const limitToSinglePosition = (input: Portfolio | null): Portfolio | null => {
  if (!input) return null;
  return { ...input, positions: input.positions.slice(0, 1) };
};

export function App() {
  const [levels, setLevels] = useState<FundedLevel[]>([]);
  const [level, setLevel] = useState<FundedLevel | null>(null);
  const [spotPrices, setSpotPrices] = useState<Record<Asset, number | null>>({
    BTC: null
  });
  const [autoRenew, setAutoRenew] = useState(true);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [protectionActive, setProtectionActive] = useState(false);
  const [protectionStart, setProtectionStart] = useState<string | null>(null);
  const [protectionExpiry, setProtectionExpiry] = useState<string | null>(null);
  const [protectedIds, setProtectedIds] = useState<string[]>([]);
  const [activeCoverages, setActiveCoverages] = useState<
    Array<{ coverageId: string; expiryIso: string; positions?: PortfolioPosition[] }>
  >([]);
  const [showAudit, setShowAudit] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [lastExecution, setLastExecution] = useState<string | null>(null);
  const [lastCoverageId, setLastCoverageId] = useState<string | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [isActivating, setIsActivating] = useState(false);
  const [fetchingDotCount, setFetchingDotCount] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditPrefetchSummary, setAuditPrefetchSummary] = useState<Record<string, unknown> | null>(
    null
  );
  const [auditPrefetchEntries, setAuditPrefetchEntries] = useState<Array<Record<string, unknown>>>([]);
  const [riskSummary, setRiskSummary] = useState<RiskSummary | null>(null);
  const [feeRegimeLabel, setFeeRegimeLabel] = useState<string | null>(null);
  const [protectionTierName, setProtectionTierName] = useState<string | null>(null);
  const [protectionLeverage, setProtectionLeverage] = useState<number | null>(null);
  const [ivSnapshot, setIvSnapshot] = useState<{ value: number | null; ts: number | null }>({
    value: null,
    ts: null
  });
  const [previewQuote, setPreviewQuote] = useState<{
    feeRegime: string | null;
    markIv: number | null;
    feeUsdc: number | null;
    quoteId?: string | null;
    quoteExpiresAt?: string | null;
    status?: string | null;
    reason?: string | null;
  } | null>(null);
  const [previewQuoteRaw, setPreviewQuoteRaw] = useState<Record<string, unknown> | null>(null);
  const [lockedQuote, setLockedQuote] = useState<{
    key: string;
    feeUsdc: number;
    lockedAt: number;
    markIv: number | null;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [previewGate, setPreviewGate] = useState("idle");
  const [previewReqStarted, setPreviewReqStarted] = useState(0);
  const [previewReqDone, setPreviewReqDone] = useState(0);
  const [previewLastError, setPreviewLastError] = useState<string | null>(null);
  const [previewTick, setPreviewTick] = useState(0);
  const previewKeyRef = useRef<string | null>(null);
  const previewLastRequestAtRef = useRef(0);
  const previewLoadingTimerRef = useRef<number | null>(null);
  const previewRequestIdRef = useRef(0);
  const previewRetryTimerRef = useRef<number | null>(null);
  const lastPricingKeyRef = useRef<string | null>(null);
  const [hedgeContext, setHedgeContext] = useState<{
    coverageId: string;
    hedgeInstrument: string;
    hedgeSize: number;
    bufferTargetPct: number;
    expiryIso: string;
    selectedVenue: string | null;
    renewPayload: Record<string, unknown>;
    notionalUsdc: number;
    hedgeType: "option" | "perp";
  } | null>(null);
  const [foxifyPosition, setFoxifyPosition] = useState<{
    equityUsd: number;
    positionSizeBtc: number;
    entryPrice?: number;
    side?: "long" | "short";
    leverage?: number;
  } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 767px)");
    const handle = () => setIsMobile(media.matches);
    handle();
    if (media.addEventListener) {
      media.addEventListener("change", handle);
      return () => media.removeEventListener("change", handle);
    }
    media.addListener(handle);
    return () => media.removeListener(handle);
  }, []);

  useEffect(() => {
    if (isMobile && showAudit) {
      setShowAudit(false);
    }
  }, [isMobile, showAudit]);

  const fetchPositions = async (accountId = "demo") => {
    try {
      const response = await fetch(
        `${API_BASE}/portfolio/positions?accountId=${encodeURIComponent(accountId)}`
      );
      const data = await response.json();
      if (data?.status !== "ok" || !Array.isArray(data.positions)) return;
      const nextPositions = data.positions
        .map((pos: any, idx: number) => {
          const entryPrice = Number(pos?.entryPrice ?? 0);
          const size = Number(pos?.size ?? 0);
          const leverage = Number(pos?.leverage ?? 1);
          if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
          if (!Number.isFinite(size) || size <= 0) return null;
          if (!Number.isFinite(leverage) || leverage <= 0) return null;
          const marginUsd = (size * entryPrice) / leverage;
          return {
            id:
              typeof pos?.id === "string"
                ? pos.id
                : `${pos?.asset || "BTC"}-${pos?.side || "long"}-${leverage}-${entryPrice}-${idx}`,
            asset: (pos?.asset || "BTC") as Asset,
            side: pos?.side === "short" ? "short" : "long",
            marginUsd,
            leverage,
            entryPrice
          } as PortfolioPosition;
        })
        .filter((pos: PortfolioPosition | null): pos is PortfolioPosition => Boolean(pos));
      setPortfolio((prev) => ({
        tierName: prev?.tierName || level?.name || "Pro (Bronze)",
        positions: nextPositions
      }));
      if (nextPositions.length > 0) {
        console.log(`✓ Loaded ${nextPositions.length} position(s) from server`);
      }
      return nextPositions;
    } catch (error) {
      console.warn("Failed to load positions on mount:", error);
    }
    return null;
  };

  const syncPositions = async (nextPortfolio: Portfolio) => {
    const accountId = "demo";
    const exposures = nextPortfolio.positions.map((pos) => ({
      asset: pos.asset,
      side: pos.side,
      entryPrice: pos.entryPrice,
      size: pos.entryPrice > 0 ? (pos.marginUsd * pos.leverage) / pos.entryPrice : 0,
      leverage: pos.leverage
    }));
    try {
      await fetch(`${API_BASE}/portfolio/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          positions: exposures,
          source: "manual"
        })
      });
      await fetchPositions(accountId);
    } catch (error) {
      console.warn("Failed to sync positions:", error);
    }
  };

  useEffect(() => {
    const loadLevels = async () => {
      const res = await fetch("/funded_levels.json");
      const data = await res.json();
      const parsed = parseFundedLevels(data);
      setLevels(parsed);
      const defaultLevel = parsed[0] || null;
      setLevel(defaultLevel);
    };
    loadLevels();
  }, [DATA_MODE, FOXIFY_ENABLED, FOXIFY_POSITION_ENDPOINT]);

  useEffect(() => {
    const fetchData = async () => {
      const accountId = "demo";
      try {
        const [positions, coverageResponse] = await Promise.all([
          fetchPositions(accountId),
          fetch(`${API_BASE}/coverage/active?accountId=${encodeURIComponent(accountId)}`).then(
            (res) => res.json()
          )
        ]);

        const coverages = Array.isArray(coverageResponse?.coverages)
          ? (coverageResponse.coverages as any[])
          : [];

        setActiveCoverages(coverages);
        if (positions && coverages.length > 0) {
          const coverageMap = new Map<string, any>();
          for (const coverage of coverages) {
            const coveragePositions = Array.isArray(coverage?.positions) ? coverage.positions : [];
            for (const pos of coveragePositions) {
              if (!pos) continue;
              const key = `${pos.asset}-${pos.side}-${pos.entryPrice}`;
              coverageMap.set(key, coverage);
            }
          }

          const protectedIds = positions
            .map((pos) => {
              const key = `${pos.asset}-${pos.side}-${pos.entryPrice}`;
              return coverageMap.has(key) ? pos.id : null;
            })
            .filter((id): id is string => Boolean(id));

          setProtectedIds(protectedIds);
          setProtectionActive(protectedIds.length > 0);

          const earliestExpiry = coverages
            .map((coverage) => coverage?.expiryIso)
            .filter((expiry): expiry is string => Boolean(expiry))
            .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
          if (earliestExpiry) {
            setProtectionExpiry(earliestExpiry);
          }
          if (coverages[0]?.coverageId) {
            setLastCoverageId(coverages[0].coverageId);
          }

          console.log(`✓ Loaded ${coverages.length} active coverage(s)`);
        } else {
          setProtectedIds([]);
          setProtectionActive(false);
          setProtectionExpiry(null);
          setLastCoverageId(null);
        }
      } catch (error) {
        console.error("Failed to fetch data:", error);
      }
    };

    fetchData();
  }, []);

  useEffect(() => {
    const loadSpot = async () => {
      const entries = await Promise.all(
        ASSETS.map(async (asset) => {
          const candidates = [`${asset.toLowerCase()}_usdc`, `${asset.toLowerCase()}_usd`];
          for (const indexName of candidates) {
            try {
              const res = await fetch(
                `https://www.deribit.com/api/v2/public/get_index_price?index_name=${indexName}`
              );
              const data = await res.json();
              const price = Number(data?.result?.index_price || 0);
              if (price) return [asset, price] as const;
            } catch {
              continue;
            }
          }
          return [asset, null] as const;
        })
      );
      setSpotPrices((prev) => {
        const next = { ...prev };
        for (const [asset, price] of entries) next[asset] = price;
        return next;
      });
    };
    loadSpot();
    const id = setInterval(loadSpot, 30000);
    return () => clearInterval(id);
  }, [DATA_MODE, FOXIFY_ENABLED, FOXIFY_PORTFOLIO_ENDPOINT]);

  useEffect(() => {
    let active = true;
    const loadIv = async () => {
      try {
        const res = await fetch(`${API_BASE}/pricing/iv/BTC`);
        if (!res.ok) throw new Error("iv_fetch_failed");
        const data = await res.json();
        const iv = Number(data?.iv);
        if (!active) return;
        setIvSnapshot({
          value: Number.isFinite(iv) ? iv : null,
          ts: Date.now()
        });
      } catch {
        if (!active) return;
        setIvSnapshot((prev) => ({ ...prev, ts: Date.now() }));
      }
    };
    loadIv();
    const id = setInterval(loadIv, 15000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const source =
      DATA_MODE === "foxify" && FOXIFY_ENABLED && FOXIFY_POSITION_ENDPOINT
        ? createFoxifyPositionSource(FOXIFY_POSITION_ENDPOINT)
        : createDemoPositionSource();
    const loadPosition = async () => {
      const next = await source.fetchPosition();
      if (next) setFoxifyPosition(next);
    };
    loadPosition();
  }, []);

  useEffect(() => {
    if (DATA_MODE !== "foxify" || !FOXIFY_ENABLED || !FOXIFY_PORTFOLIO_ENDPOINT) {
      if (DATA_MODE === "foxify" && !FOXIFY_ENABLED) {
        setPortfolioError("Foxify integration disabled until approval.");
      }
      return;
    }
    const loadPortfolio = async () => {
      const res = await fetch(FOXIFY_PORTFOLIO_ENDPOINT);
      const data = await res.json();
      const validated = validatePortfolio(data);
      if (!validated.ok) {
        setPortfolioError(validated.error || "Invalid portfolio response.");
        return;
      }
      setPortfolioError(null);
      const nextPortfolio = validated.value || null;
      setPortfolio(nextPortfolio);
      if (nextPortfolio?.tierName) {
        const matched = levels.find((item) => item.name === nextPortfolio.tierName) || null;
        if (matched) setLevel(matched);
      }
    };
    loadPortfolio();
  }, []);

  useEffect(() => {
    if (DATA_MODE !== "demo") return;
    const saved = localStorage.getItem("foxify_portfolio");
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      const validated = validatePortfolio(parsed);
      if (!validated.ok) return;
      const nextPortfolio = validated.value || null;
      setPortfolio(nextPortfolio);
      if (nextPortfolio?.tierName) {
        const matched = levels.find((item) => item.name === nextPortfolio.tierName) || null;
        if (matched) setLevel(matched);
      }
    } catch {
      return;
    }
  }, [levels]);

  useEffect(() => {
    if (DATA_MODE !== "demo" || !portfolio) return;
    localStorage.setItem("foxify_portfolio", JSON.stringify(portfolio));
  }, [portfolio]);

  useEffect(() => {
    if (!portfolio?.positions?.length) {
      if (selectedIds.length === 0) return;
      setSelectedIds([]);
      return;
    }
    const valid = new Set(portfolio.positions.map((pos) => pos.id));
    const nextSelected = selectedIds.filter((id) => valid.has(id));
    if (nextSelected.length !== selectedIds.length) {
      setSelectedIds(nextSelected);
    }
  }, [portfolio, selectedIds]);

  const drawdownPct = level ? Number(level.drawdown_limit_pct) : 0;
  const fundingUsd = level ? Number(level.funding_usdc) : 0;
  const expiryDays = level?.expiry_days ? Number(level.expiry_days) : 7;
  const renewWindowMinutes = level?.renew_window_minutes
    ? Number(level.renew_window_minutes)
    : 1440;
  const bufferAlertPct = level?.buffer_alert_pct ? Number(level.buffer_alert_pct) : 2;

  const portfolioStats = useMemo(() => {
    const positions = portfolio?.positions ?? [];
    const totalMargin = positions.reduce((sum, p) => sum + p.marginUsd, 0);
    const entries = positions.map((p) => {
      const spot = spotPrices[p.asset] || p.entryPrice;
      const notional = p.marginUsd * p.leverage;
      const sizeUnits = spot ? notional / p.entryPrice : 0;
      const pnl =
        spot && p.entryPrice
          ? (p.side === "long" ? spot - p.entryPrice : p.entryPrice - spot) *
            sizeUnits
          : 0;
      return { ...p, notional, sizeUnits, pnl };
    });
    const netByAsset = entries.reduce<Record<Asset, { netSize: number; netCost: number }>>(
      (acc, p) => {
        const signedSize = p.sizeUnits * (p.side === "long" ? 1 : -1);
        const cost = signedSize * p.entryPrice;
        if (!acc[p.asset]) {
          acc[p.asset] = { netSize: 0, netCost: 0 };
        }
        acc[p.asset].netSize += signedSize;
        acc[p.asset].netCost += cost;
        return acc;
      },
      {} as Record<Asset, { netSize: number; netCost: number }>
    );
    const netPnl = Object.entries(netByAsset).reduce((sum, [asset, net]) => {
      const spot = spotPrices[asset as Asset] || 0;
      if (!spot || net.netSize === 0) return sum;
      const avgEntry = net.netCost / net.netSize;
      return sum + (spot - avgEntry) * net.netSize;
    }, 0);
    const totalPnl = netPnl;
    const equityUsd = fundingUsd + totalPnl;
    const floorUsd = fundingUsd * (1 - drawdownPct);
    return {
      totalMargin,
      totalPnl,
      equityUsd,
      floorUsd,
      distanceToFloor: equityUsd - floorUsd,
      entries
    };
  }, [portfolio, spotPrices, fundingUsd, drawdownPct]);

  useEffect(() => {
    if (!portfolio || !level || fundingUsd <= 0) {
      setRiskSummary(null);
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      try {
        const params = new URLSearchParams({
          cashUsdc: fundingUsd.toFixed(2),
          positionPnlUsdc: portfolioStats.totalPnl.toFixed(2),
          drawdownLimitUsdc: portfolioStats.floorUsd.toFixed(2),
          initialBalanceUsdc: fundingUsd.toFixed(2),
          maxMtmAgeMs: "15000"
        });
        const res = await fetch(`${API_BASE}/risk/summary?${params.toString()}`, {
          signal: controller.signal
        });
        if (!res.ok) throw new Error("risk_summary_failed");
        const data = (await res.json()) as RiskSummary;
        if (!controller.signal.aborted) {
          setRiskSummary(data);
        }
      } catch {
        if (!controller.signal.aborted) {
          setRiskSummary(null);
        }
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [portfolio, level, fundingUsd, portfolioStats.totalPnl, portfolioStats.floorUsd]);

  const currentPositions = portfolioStats.entries;
  const selectedPositions = useMemo(
    () => currentPositions.filter((p) => selectedIds.includes(p.id)),
    [currentPositions, selectedIds]
  );
  const pricingKey = useMemo(() => {
    if (!level || selectedPositions.length !== 1) return null;
    const primary = selectedPositions[0];
    return [
      level.name,
      expiryDays,
      drawdownPct,
      primary.id,
      primary.asset,
      primary.side,
      primary.leverage,
      primary.marginUsd,
      primary.entryPrice
    ].join("|");
  }, [level, selectedPositions, expiryDays, drawdownPct]);
  const QUOTE_LOCK_TTL_MS = 6000;
  const baseFeeUsdRaw = level ? Number(level.fixed_price_usdc) : 0;
  const baseFeeUsd = Number.isFinite(baseFeeUsdRaw) ? baseFeeUsdRaw : 0;
  const perAssetFeeUsd = level
    ? selectedPositions.reduce((sum) => sum + baseFeeUsd, 0)
    : 0;
  const totalFeeUsd = perAssetFeeUsd;

  const shortTierLabel = () => {
    if (!level?.name) return "—";
    const match = level.name.match(/\(([^)]+)\)/);
    return match ? match[1] : level.name;
  };

  const buildCoverageId = (expiryIso: string) => {
    const ids = selectedIds[0] ?? "unknown";
    const day = expiryIso.slice(0, 10);
    return `${level?.name || "unknown"}:${day}:${ids}`;
  };

  const formatFeeRegime = (regime?: string | null) => {
    if (!regime) return null;
    switch (regime) {
      case "low":
        return "Low Vol Pricing";
      case "high":
        return "High Vol Pricing";
      default:
        return "Normal Vol Pricing";
    }
  };

  const formatVolStatus = (regime?: string | null) => {
    if (!regime) return null;
    switch (regime) {
      case "low":
        return "Low Vol";
      case "high":
        return "High Vol";
      default:
        return "Normal Vol";
    }
  };

  useEffect(() => {
    if (!pricingKey) {
      if (lockedQuote) setLockedQuote(null);
      return;
    }
    if (lockedQuote && lockedQuote.key !== pricingKey) {
      setLockedQuote(null);
    }
  }, [pricingKey, lockedQuote]);

  const forcePreviewQuote = async () => {
    if (!level || selectedPositions.length !== 1) return;
    const primary = selectedPositions[0];
    if (!primary) return;
    const spot = spotPrices[primary.asset] || primary.entryPrice;
    if (!spot || baseFeeUsd <= 0) return;
    setPreviewLastError(null);
    setPreviewLoading(true);
    setPreviewState("loading");
    try {
      const res = await fetch(`${API_BASE}/put/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tierName: level.name,
          asset: primary.asset,
          spotPrice: spot,
          drawdownFloorPct: drawdownPct,
          fixedPriceUsdc: baseFeeUsd,
          positionSize: primary.sizeUnits,
          contractSize: 1,
          leverage: primary.leverage ?? 1,
          ivSnapshot: ivSnapshot.value,
          side: primary.side,
          coverageId: "preview",
          targetDays: expiryDays,
          allowPremiumPassThrough: FOXIFY_APPROVED
        })
      });
      if (!res.ok) throw new Error("force_quote_failed");
      const data = await res.json();
      const feeUsdc = Number(data?.feeUsdc);
      const markIv = Number(data?.markIv);
      if (!Number.isFinite(feeUsdc)) throw new Error("force_quote_invalid");
      setPreviewQuote({
        feeRegime: data?.feeRegime ?? null,
        markIv: Number.isFinite(markIv) ? markIv : null,
        feeUsdc: Number.isFinite(feeUsdc) ? feeUsdc : null,
        quoteId: data?.quoteId ?? null,
        quoteExpiresAt: data?.quoteExpiresAt ?? null,
        status: data?.status ?? null,
        reason: data?.reason ?? null
      });
      setPreviewQuoteRaw(data && typeof data === "object" ? (data as Record<string, unknown>) : null);
      setPreviewState("ok");
    } catch {
      setPreviewLastError("request_failed");
      setPreviewState("error");
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!lockedQuote) return;
    if (Date.now() - lockedQuote.lockedAt <= QUOTE_LOCK_TTL_MS) return;
    setLockedQuote(null);
  }, [lockedQuote, QUOTE_LOCK_TTL_MS]);

  useEffect(() => {
    if (!pricingKey) {
      lastPricingKeyRef.current = null;
      return;
    }
    if (lastPricingKeyRef.current && lastPricingKeyRef.current !== pricingKey) {
      setPreviewQuote(null);
      setPreviewQuoteRaw(null);
      setPreviewState("idle");
      setPreviewGate("idle");
      setPreviewLastError(null);
      previewLastRequestAtRef.current = 0;
      if (lockedQuote?.key !== pricingKey) {
        setLockedQuote(null);
      }
    }
    lastPricingKeyRef.current = pricingKey;
  }, [pricingKey, lockedQuote]);

  useEffect(() => {
    if (!level || selectedIds.length !== 1) {
      setPreviewGate("no_selection");
      setPreviewQuote(null);
      setPreviewQuoteRaw(null);
      setPreviewLoading(false);
      setPreviewState("idle");
      return;
    }
    const primary = selectedPositions[0];
    if (!primary) {
      setPreviewGate("no_primary");
      setPreviewQuote(null);
      setPreviewQuoteRaw(null);
      setPreviewLoading(false);
      setPreviewState("idle");
      return;
    }
    const spot = spotPrices[primary.asset] || primary.entryPrice;
    if (!spot || baseFeeUsd <= 0) {
      setPreviewGate("no_spot_fee");
      setPreviewQuote(null);
      setPreviewQuoteRaw(null);
      setPreviewLoading(false);
      setPreviewState("idle");
      return;
    }
    const key = `${selectedIds[0]}|${level.name}|${expiryDays}|${drawdownPct}|${primary.leverage}|${primary.marginUsd}|${primary.side}|${primary.entryPrice}`;
    const now = Date.now();
    const minIntervalMs = 6000;
    if (lockedQuote?.key === pricingKey && lockedQuote.lockedAt + QUOTE_LOCK_TTL_MS > now) {
      setPreviewGate("locked_ttl");
      return;
    }
    const lastRequestAt = previewLastRequestAtRef.current || 0;
    const hasFreshQuote = Boolean(lockedQuote?.key === pricingKey || previewQuote?.feeUsdc);
    if (hasFreshQuote && now - lastRequestAt < minIntervalMs && previewState !== "loading") {
      setPreviewGate("throttled");
      return;
    }
    previewKeyRef.current = key;
    previewLastRequestAtRef.current = now;
    setPreviewLoading(true);
    setPreviewState("loading");
    if (previewLoadingTimerRef.current) {
      clearTimeout(previewLoadingTimerRef.current);
      previewLoadingTimerRef.current = null;
    }
    const requestId = ++previewRequestIdRef.current;
    const timeoutId = window.setTimeout(() => {
      if (requestId !== previewRequestIdRef.current) return;
      setPreviewState("error");
      setPreviewLoading(false);
    }, 8000);
    setPreviewGate("fetching");
    const run = async () => {
      setPreviewReqStarted((prev) => prev + 1);
      setPreviewLastError(null);
      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => {
        controller.abort();
      }, 6000);
      try {
        const res = await fetch(`${API_BASE}/put/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            tierName: level.name,
            asset: primary.asset,
            spotPrice: spot,
            drawdownFloorPct: drawdownPct,
            positionSize: primary.sizeUnits,
            fixedPriceUsdc: baseFeeUsd,
            contractSize: 1,
            leverage: primary.leverage ?? 1,
            ivSnapshot: ivSnapshot.value,
            side: primary.side,
            coverageId: "preview",
            targetDays: expiryDays,
            allowPremiumPassThrough: FOXIFY_APPROVED
          })
        });
        if (!res.ok) throw new Error("preview_quote_failed");
        const data = await res.json();
        if (requestId !== previewRequestIdRef.current) return;
        if (data?.status === "pending") {
          setPreviewGate("pending");
          setPreviewState("loading");
          setPreviewQuote(null);
          setPreviewQuoteRaw(null);
          if (previewRetryTimerRef.current) {
            clearTimeout(previewRetryTimerRef.current);
          }
          previewRetryTimerRef.current = window.setTimeout(() => {
            setPreviewTick((prev) => prev + 1);
          }, 800);
          return;
        }
        const feeUsdc = Number(data?.feeUsdc);
        const markIv = Number(data?.markIv ?? 0);
        if (!Number.isFinite(feeUsdc)) throw new Error("preview_quote_invalid");
        setPreviewQuote({
          feeRegime: data?.feeRegime ?? null,
          markIv: Number.isFinite(markIv) ? markIv : null,
          feeUsdc: Number.isFinite(feeUsdc) ? feeUsdc : null,
          quoteId: data?.quoteId ?? null,
          quoteExpiresAt: data?.quoteExpiresAt ?? null,
          status: data?.status ?? null,
          reason: data?.reason ?? (data?.status ? String(data.status) : null)
        });
        setPreviewQuoteRaw(data && typeof data === "object" ? (data as Record<string, unknown>) : null);
        setPreviewState("ok");
      } catch (err) {
        if (requestId !== previewRequestIdRef.current) return;
        if ((err as Error)?.name === "AbortError") {
          setPreviewLastError("timeout");
        } else {
          setPreviewLastError("request_failed");
        }
        setPreviewState("error");
      } finally {
        clearTimeout(abortTimer);
        setPreviewReqDone((prev) => prev + 1);
        if (requestId === previewRequestIdRef.current) {
          clearTimeout(timeoutId);
          if (previewLoadingTimerRef.current) {
            clearTimeout(previewLoadingTimerRef.current);
            previewLoadingTimerRef.current = null;
          }
          if (previewRetryTimerRef.current) {
            clearTimeout(previewRetryTimerRef.current);
            previewRetryTimerRef.current = null;
          }
          setPreviewLoading(false);
        }
      }
    };
    run();
    return () => {
      if (previewLoadingTimerRef.current) {
        clearTimeout(previewLoadingTimerRef.current);
        previewLoadingTimerRef.current = null;
      }
      if (previewRetryTimerRef.current) {
        clearTimeout(previewRetryTimerRef.current);
        previewRetryTimerRef.current = null;
      }
      clearTimeout(timeoutId);
    };
  }, [
    level,
    selectedIds,
    selectedPositions,
    drawdownPct,
    expiryDays,
    baseFeeUsd,
    ivSnapshot.value,
    lockedQuote,
    pricingKey,
    previewTick
  ]);

  useEffect(() => {
    if (!pricingKey || !previewQuote || previewState !== "ok") return;
    const fee = previewQuote.feeUsdc;
    if (!Number.isFinite(fee) || !fee || fee <= 0) return;
    if (!lockedQuote || lockedQuote.key !== pricingKey) {
      setLockedQuote({
        key: pricingKey,
        feeUsdc: fee,
        lockedAt: Date.now(),
        markIv: previewQuote.markIv ?? null
      });
    }
  }, [pricingKey, previewQuote, previewState, lockedQuote]);

  const handleExecute = async () => {
    if (!level || !portfolio || selectedIds.length === 0) return;
    if (selectedIds.length > 1) {
      setLastExecution("Select a single position for protection.");
      return;
    }
    setIsActivating(true);
    const start = new Date();
    const expiry =
      protectionActive && protectionExpiry
        ? new Date(protectionExpiry)
        : new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
    const coverageId = buildCoverageId(expiry.toISOString());
    const activeCoverage = activeCoverages.find((coverage) => coverage.coverageId === coverageId);
    if (protectionActive && activeCoverage) {
      const activeExpiryMs = Date.parse(activeCoverage.expiryIso || "");
      if (Number.isFinite(activeExpiryMs) && activeExpiryMs > Date.now()) {
      setLastExecution("Protection already active for this window.");
      setIsActivating(false);
      return;
      }
    }
    const primary = selectedPositions[0];
    const primaryAsset = primary?.asset ?? "BTC";
    const spot = primary ? spotPrices[primaryAsset] || primary.entryPrice : 0;
    const netSide: "long" | "short" = primary?.side ?? "long";
    const positionSize = primary?.sizeUnits ?? 0;
    const notionalUsdc = spot ? positionSize * spot : 0;
    const floorPrice = spot
      ? netSide === "long"
        ? spot * (1 - drawdownPct)
        : spot * (1 + drawdownPct)
      : null;

    const previewExpiresAt = previewQuote?.quoteExpiresAt
      ? new Date(previewQuote.quoteExpiresAt).getTime()
      : null;
    const previewFresh = previewExpiresAt ? previewExpiresAt > Date.now() : false;
    const previewStatus = String((previewQuoteRaw as any)?.status ?? "ok");
    const canUsePreviewQuote =
      previewFresh &&
      previewQuoteRaw &&
      (previewStatus === "ok" || previewStatus === "pass_through" || previewStatus === "pass_through_capped");
    let quote: any = canUsePreviewQuote ? previewQuoteRaw : null;
    let hedgeType: "option" | "perp" = "option";
    let hedgeInstrument = "";
    let hedgeSize = 0;
    let bufferTargetPct = 0.05;
    let feeUsd = totalFeeUsd;
    let markupUsd: number | null = null;
    let premiumOutUsd: number | null = null;
    let executedPremiumUsd: number | null = null;
    let subsidyUsd = 0;
    let reason = "flat_fee";
    let regimeLabel: string | null = null;
    let selectedVenue: string | null = null;

    let orderResponse: any = null;
    try {
      if (spot) {
        if (canUsePreviewQuote) {
          quote = previewQuoteRaw;
        }
        const maxAttempts = 3;
        let cacheBust = false;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          if (attempt === 0 && canUsePreviewQuote && !cacheBust) {
            quote = previewQuoteRaw;
          } else {
            const quoteRes = await fetch(`${API_BASE}/put/quote`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tierName: level.name,
                asset: primaryAsset,
                spotPrice: spot,
                drawdownFloorPct: drawdownPct,
                fixedPriceUsdc: totalFeeUsd,
                positionSize,
                contractSize: 1,
                leverage: primary?.leverage ?? 1,
                ivSnapshot: ivSnapshot.value,
                side: netSide,
                coverageId,
                targetDays: expiryDays,
                allowPremiumPassThrough: true,
                _cacheBust: cacheBust
              })
            });
            quote = await quoteRes.json();
          }

          if (quote?.status === "pass_through" || quote?.status === "pass_through_capped") {
            const pricing = quote?.pricing;
            const message =
              quote.status === "pass_through"
                ? `High volatility: Premium is ${pricing?.ratio || "N/A"}× base premium floor. You'll be charged $${quote.feeUsdc} for full protection.`
                : `Premium exceeds tier cap. Premium capped at $${quote.feeUsdc}. Platform subsidizing $${quote.subsidyUsdc || "0"} for full protection.`;
            setLastExecution(message);
          }

          if (quote?.status === "partial") {
            setLastExecution(
              `Partial coverage is not supported for ${level.name}. ` +
                "Upgrade tier or adjust leverage/duration for full protection."
            );
            setIsActivating(false);
            return;
          }

          if (quote?.status === "premium_floor") {
            const ratio = quote?.warning?.ratio ?? "";
            const explanation =
              quote?.pricing?.explanation ||
              `Premium exceeds premium floor${ratio ? ` (ratio ${ratio}).` : "."} Pass-through required.`;
            setLastExecution(explanation);
            setIsActivating(false);
            return;
          }

          const optionUnavailable =
            !quote || quote.status === "no_quote" || quote.status === "perp_fallback";
          if (optionUnavailable) {
            continue;
          }

          feeUsd = quote.feeUsdc ? Number(quote.feeUsdc) : totalFeeUsd;
          subsidyUsd = quote.subsidyUsdc ? Number(quote.subsidyUsdc) : 0;
          reason = quote.reason || "flat_fee";
          regimeLabel = formatFeeRegime(quote.feeRegime);
          const markupCandidate = quote?.premiumMarkupUsdc;
          const markupValue = markupCandidate !== null && markupCandidate !== undefined
            ? Number(markupCandidate)
            : null;
          markupUsd = Number.isFinite(markupValue ?? NaN) ? (markupValue as number) : null;
          const premiumCandidate =
            quote?.rollEstimatedPremiumUsdc ?? quote?.premiumUsdc ?? null;
          const premiumValue = premiumCandidate !== null && premiumCandidate !== undefined
            ? Number(premiumCandidate)
            : null;
          premiumOutUsd = Number.isFinite(premiumValue ?? NaN) ? (premiumValue as number) : null;

          hedgeInstrument = quote.instrument;
          hedgeSize = Number(quote.hedgeSize || 0);
          bufferTargetPct = Number(quote.bufferTargetPct || 0.05);
          selectedVenue = quote?.optionVenue ?? quote?.venueSelection?.selected ?? null;

          const plans =
            Array.isArray(quote?.executionPlan) && quote.executionPlan.length > 0
              ? quote.executionPlan
              : [
                  {
                    instrument: hedgeInstrument,
                    side: "buy",
                    size: hedgeSize,
                    venue: selectedVenue
                  }
                ];
          let remainingSize = hedgeSize;
          let filledTotal = 0;
          let executedAny = false;
          let lastResponse: any = null;
          let lastExecuted: any = null;

          for (const plan of plans) {
            if (remainingSize <= 0) break;
            const planSize = Number(plan?.size ?? remainingSize);
            const amount = Math.min(remainingSize, Number.isFinite(planSize) ? planSize : remainingSize);
            if (!Number.isFinite(amount) || amount <= 0) continue;
            const planVenue = plan?.venue ?? selectedVenue ?? null;
            const orderRes = await fetch(`${API_BASE}/deribit/order`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                instrument: plan?.instrument ?? hedgeInstrument,
                amount,
                side: plan?.side === "sell" ? "sell" : "buy",
                type: "market",
                venue: planVenue ?? undefined,
                quoteId: quote?.quoteId ?? previewQuote?.quoteId ?? null,
                coverageId,
                notionalUsdc,
                hedgeType: "option",
                feeUsdc: feeUsd,
                tierName: level.name,
                premiumUsdc: quote?.premiumUsdc ?? null,
              spotPrice: spot,
              floorPrice,
                feeRecognized: true,
                subsidyUsdc: subsidyUsd,
                reason
              })
            });
            lastResponse = await orderRes.json();
            const executed =
              lastResponse &&
              (lastResponse.status === "paper_filled" ||
                lastResponse.status === "filled" ||
                lastResponse.status === "ok");
            if (executed) {
              const filledAmount = Number(lastResponse?.filledAmount ?? amount);
              const filled = Number.isFinite(filledAmount) ? filledAmount : 0;
              filledTotal += filled;
              remainingSize = Math.max(0, remainingSize - filled);
              executedAny = true;
              lastExecuted = lastResponse;
              if (remainingSize <= 0) break;
              continue;
            }
            const reasonText = String(lastResponse?.reason || "");
            const retryable =
              lastResponse?.status === "paper_rejected" &&
              (reasonText === "no_top_of_book" || reasonText === "insufficient_liquidity");
            if (!retryable) break;
          }

          if (executedAny) {
            orderResponse = {
              ...lastExecuted,
              filledAmount: filledTotal
            };
            hedgeSize = filledTotal;
            break;
          }

          orderResponse = lastResponse;
          const orderReason = String(orderResponse?.reason || "");
          const shouldRequote =
            orderResponse?.status === "rejected" &&
            (orderReason === "quote_drift" ||
              orderReason === "quote_expired" ||
              orderReason === "quote_unknown");
          if (shouldRequote && attempt < maxAttempts - 1) {
            cacheBust = true;
            orderResponse = null;
            continue;
          }
          const reasonText = String(orderResponse?.reason || "");
          const retryable =
            orderResponse?.status === "paper_rejected" &&
            (reasonText === "no_top_of_book" || reasonText === "insufficient_liquidity");
          if (!retryable) break;
        }

        if (
          !orderResponse ||
          (orderResponse.status !== "paper_filled" &&
            orderResponse.status !== "filled" &&
            orderResponse.status !== "ok")
        ) {
          if (quote?.status === "perp_fallback") {
            hedgeType = "perp";
            hedgeInstrument = `${primaryAsset}-PERPETUAL`;
            hedgeSize = spot ? Number(notionalUsdc / spot) : 0;
            bufferTargetPct = 0.04;
            reason = "perp_fallback";
            const fallbackRes = await fetch(`${API_BASE}/deribit/order`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                instrument: hedgeInstrument,
                amount: hedgeSize,
                side: "buy",
                type: "market",
                quoteId: quote?.quoteId ?? previewQuote?.quoteId ?? null,
                coverageId,
                notionalUsdc,
                hedgeType: "perp",
                feeUsdc: feeUsd,
                tierName: level.name,
                spotPrice: spot,
                feeRecognized: true,
                leverage: primary?.leverage ?? 1,
                reason
              })
            });
            orderResponse = await fallbackRes.json();
          }
        }
        if (quote && premiumOutUsd === null && markupUsd === null) {
          const markupCandidate = quote?.premiumMarkupUsdc;
          const markupValue = markupCandidate !== null && markupCandidate !== undefined
            ? Number(markupCandidate)
            : null;
          markupUsd = Number.isFinite(markupValue ?? NaN) ? (markupValue as number) : null;
          const premiumCandidate =
            quote?.rollEstimatedPremiumUsdc ?? quote?.premiumUsdc ?? null;
          const premiumValue = premiumCandidate !== null && premiumCandidate !== undefined
            ? Number(premiumCandidate)
            : null;
          premiumOutUsd = Number.isFinite(premiumValue ?? NaN) ? (premiumValue as number) : null;
        }
      }
    } catch {
      orderResponse = null;
    }

    if (
      !orderResponse ||
      (orderResponse.status !== "paper_filled" && orderResponse.status !== "filled" && orderResponse.status !== "ok")
    ) {
      const status = orderResponse?.status ? String(orderResponse.status) : "unknown";
      const reason = orderResponse?.reason ? String(orderResponse.reason) : "no_response";
      setLastExecution(
        `No executable liquidity available. Protection not activated. (${status}: ${reason})`
      );
      setIsActivating(false);
      return;
    }
    if (orderResponse?.filledAmount && Number.isFinite(Number(orderResponse.filledAmount))) {
      hedgeSize = Number(orderResponse.filledAmount);
    }
    if (orderResponse) {
      const fillPriceRaw =
        (orderResponse as any)?.result?.average_price ??
        (orderResponse as any)?.result?.price ??
        (orderResponse as any)?.fillPrice ??
        (orderResponse as any)?.price ??
        null;
      const filledAmountRaw =
        (orderResponse as any)?.filledAmount ??
        (orderResponse as any)?.result?.filled_amount ??
        (orderResponse as any)?.amount ??
        null;
      const fillPrice = Number(fillPriceRaw);
      const filledAmount = Number(filledAmountRaw);
      if (Number.isFinite(fillPrice) && Number.isFinite(filledAmount) && filledAmount > 0) {
        const isBybit = hedgeInstrument.endsWith("-USDT");
        const premium = isBybit
          ? fillPrice * filledAmount
          : spot
            ? fillPrice * filledAmount * spot
            : null;
        if (premium !== null && Number.isFinite(premium)) {
          executedPremiumUsd = premium;
        }
      }
    }

    const selectedPortfolioPositions =
      portfolio?.positions.filter((position) => selectedIds.includes(position.id)) ?? [];
    const payload = {
      ts: start.toISOString(),
      tier: level.name,
      autoRenew,
      feeUsd,
      baseFeeUsd,
      markupUsd,
      selectedVenue,
      totalFeeUsd: feeUsd,
      subsidyUsd,
      reason,
      quoteId: quote?.quoteId ?? previewQuote?.quoteId ?? null,
      selectedIds,
      coverageId,
      portfolio: {
        tierName: level.name,
        positions: selectedPortfolioPositions
      },
      floorUsd: Number(portfolioStats.floorUsd.toFixed(2)),
      equityUsd: Number(portfolioStats.equityUsd.toFixed(2)),
      expiryIso: expiry.toISOString(),
      notionalUsdc,
      hedge: {
        hedgeType,
        instrument: hedgeInstrument || null,
        venue: selectedVenue,
        quoteId: quote?.quoteId ?? previewQuote?.quoteId ?? null,
        premiumUsdc: executedPremiumUsd ?? premiumOutUsd ?? null,
        quotedPremiumUsdc: premiumOutUsd ?? null,
        executedPremiumUsdc: executedPremiumUsd ?? null,
        subsidyUsdc: subsidyUsd || null,
        reason,
        hedgeSize: hedgeSize || null,
        optionType: quote?.optionType ?? null,
        strike: quote?.strike ?? null,
        floorPrice: quote?.survivalCheck?.floorPrice ?? null,
        expiryTag: quote?.expiryTag ?? null,
        targetDays: quote?.targetDays ?? null,
        order: orderResponse
      }
    };
    localStorage.setItem("foxify_protect_last", JSON.stringify(payload));
    fetch(`${API_BASE}/audit/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(() => null);
    setLastExecution(`Saved: ${payload.ts}`);
    setLastCoverageId(coverageId);
    setProtectionActive(true);
    setProtectionStart(payload.ts);
    setProtectionExpiry((prev) => {
      if (!prev) return payload.expiryIso;
      const prevMs = Date.parse(prev);
      const nextMs = Date.parse(payload.expiryIso);
      if (!Number.isFinite(prevMs)) return payload.expiryIso;
      if (!Number.isFinite(nextMs)) return prev;
      return nextMs < prevMs ? payload.expiryIso : prev;
    });
    setProtectedIds((prev) => Array.from(new Set([...prev, ...selectedIds])));
    setActiveCoverages((prev) => {
      const next = prev.filter((coverage) => coverage.coverageId !== coverageId);
      next.push({
        coverageId,
        expiryIso: payload.expiryIso,
        positions: selectedPortfolioPositions
      });
      return next;
    });
    setFeeRegimeLabel(regimeLabel);
    setProtectionTierName(level.name);
    setProtectionLeverage(primary?.leverage ?? null);
    if (hedgeType === "option" && hedgeInstrument && hedgeSize > 0) {
      setHedgeContext({
        coverageId,
        hedgeInstrument,
        hedgeSize,
        bufferTargetPct,
        expiryIso: payload.expiryIso,
        selectedVenue,
        renewPayload: {
          tierName: level.name,
          asset: primaryAsset,
          spotPrice: spot,
          drawdownFloorPct: drawdownPct,
          fixedPriceUsdc: totalFeeUsd,
          expiryTag: quote?.expiryTag,
          targetDays: expiryDays,
          amount: hedgeSize,
          renewWindowMinutes,
          expiryIso: payload.expiryIso,
          side: netSide,
          coverageId,
          allowPremiumPassThrough: FOXIFY_APPROVED
        },
        notionalUsdc,
        hedgeType: "option"
      });
    } else {
      setHedgeContext({
        coverageId,
        hedgeInstrument,
        hedgeSize,
        bufferTargetPct,
        expiryIso: payload.expiryIso,
        selectedVenue,
        renewPayload: {},
        notionalUsdc,
        hedgeType: "perp"
      });
    }
    setToast("Protection activated.");
    setTimeout(() => setToast(null), 2500);
    setIsActivating(false);
  };

  const formatUsd = (value: number) =>
    value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const formatPrice = (value: number) =>
    value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const mtmEquity = riskSummary ? Number(riskSummary.equityUsdc) : portfolioStats.equityUsd;
  const mtmDistanceToFloor = mtmEquity - portfolioStats.floorUsd;
  const mtmBufferPct = riskSummary ? Number(riskSummary.drawdownBufferPct) : null;
  const mtmBufferLow = mtmBufferPct !== null && mtmBufferPct < bufferAlertPct;

  const formatTimer = (expiryIso: string | null) => {
    if (!expiryIso) return "—";
    const remaining = new Date(expiryIso).getTime() - Date.now();
    if (remaining <= 0) return "Expired";
    const hours = Math.floor(remaining / 3600000);
    const minutes = Math.floor((remaining % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  };

  const handleRenew = () => {
    const expiry = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
    setProtectionExpiry(expiry.toISOString());
  };

  useEffect(() => {
    if (DATA_MODE !== "demo" || !protectionActive || !hedgeContext) return;
    const id = setInterval(() => {
      const exposures = currentPositions.map((pos) => ({
        asset: pos.asset,
        side: pos.side,
        entryPrice: pos.entryPrice,
        size: pos.sizeUnits,
        leverage: pos.leverage
      }));
      fetch(`${API_BASE}/loop/tick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: "demo",
          drawdownLimitUsdc: portfolioStats.floorUsd.toFixed(2),
          initialBalanceUsdc: fundingUsd.toFixed(2),
          hedgeInstrument: hedgeContext.hedgeInstrument,
          hedgeSize: hedgeContext.hedgeSize,
          bufferTargetPct: hedgeContext.bufferTargetPct,
          hysteresisPct: 0.02,
          expiryIso: hedgeContext.expiryIso,
          renewWindowMinutes,
          renewPayload: hedgeContext.renewPayload,
          coverageId: hedgeContext.coverageId,
          autoRenew,
          notionalUsdc: hedgeContext.notionalUsdc,
          hedgeType: hedgeContext.hedgeType,
          selectedVenue: hedgeContext.selectedVenue,
          tierName: level?.name || "Unknown",
          exposures
        })
      }).catch(() => null);
    }, 60000);
    return () => clearInterval(id);
  }, [
    DATA_MODE,
    protectionActive,
    hedgeContext,
    portfolioStats.floorUsd,
    fundingUsd,
    currentPositions
  ]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? [] : [id]));
    previewLastRequestAtRef.current = 0;
    setPreviewTick((prev) => prev + 1);
  };

  const remainingMargin = level
    ? Number(level.funding_usdc) - portfolioStats.totalMargin
    : 0;
  const hasProtectedPosition =
    portfolio?.positions?.some((pos) => protectedIds.includes(pos.id)) ?? false;
  const volAdjusted =
    previewQuote &&
    (previewQuote.feeRegime === "low" || previewQuote.feeRegime === "high") &&
    previewQuote.feeUsdc !== null &&
    Math.abs(previewQuote.feeUsdc - baseFeeUsd) > 0.01;
  const volStatusLabel =
    volAdjusted ? formatVolStatus(previewQuote?.feeRegime ?? null) : null;
  const volIvLabel =
    volAdjusted && previewQuote?.markIv !== null
      ? previewQuote.markIv.toFixed(2)
      : null;
  const volMessage =
    volStatusLabel && volIvLabel ? `${volStatusLabel} · IV ${volIvLabel}` : null;
  const previewError = previewState === "error";
  const hasSelection = selectedPositions.length > 0;
  const isFetchingQuote =
    previewState === "loading" || previewGate === "fetching" || previewGate === "pending";
  useEffect(() => {
    if (!isFetchingQuote) {
      setFetchingDotCount(1);
      return;
    }
    const id = window.setInterval(() => {
      setFetchingDotCount((prev) => (prev >= 3 ? 1 : prev + 1));
    }, 500);
    return () => window.clearInterval(id);
  }, [isFetchingQuote]);
  const fetchingDots = ".".repeat(fetchingDotCount);
  const displayFeeUsd = (() => {
    if (!hasSelection) return null;
    if (lockedQuote?.key === pricingKey) return lockedQuote.feeUsdc;
    if (previewState === "ok" && previewQuote && previewQuote.feeUsdc !== null && previewQuote.feeUsdc > 0) {
      return previewQuote.feeUsdc;
    }
    return null;
  })();
  const isCheckingVolatility =
    previewLoading ||
    previewState === "loading" ||
    previewState === "error" ||
    previewError ||
    previewState === "idle";
  const pricingStatusLabel = null;
  const feeDisplayLabel = displayFeeUsd ? `$${formatUsd(displayFeeUsd)}` : "-";

  return (
    <div className="shell">
      <div className={`card${showAudit ? " card-wide" : ""}`}>
        <div className="title">
          <span className="brand">
            <img
              src="https://i.ibb.co/SDwxMqS8/Foxify-200x200.png"
              alt="Foxify 200x200"
            />
            Foxify <span className="brand-accent">PROTECT</span>
            <span className="pill">Active</span>
          </span>
          <div className="header-actions">
            {DATA_MODE === "demo" ? (
              <>
                <button className="btn" onClick={() => setPortfolioOpen(true)}>
                  {protectionActive ? "Add" : portfolio ? "Edit" : "Add"} Position
                </button>
                <button
                  className="btn audit-toggle"
                  onClick={async () => {
                    if (showAudit) {
                      setShowAudit(false);
                      return;
                    }
                    if (auditLoading) return;
                    setAuditLoading(true);
                    try {
                      const summaryRes = await fetch(`${API_BASE}/audit/summary?mode=internal`);
                      if (!summaryRes.ok) throw new Error("audit_summary_failed");
                      const summaryData = await summaryRes.json();

                      const entriesRes = await fetch(`${API_BASE}/audit/logs?limit=200`);
                      if (!entriesRes.ok) throw new Error("audit_entries_failed");

                      const entriesData = await entriesRes.json();
                      setAuditPrefetchSummary(summaryData);
                      setAuditPrefetchEntries(
                        Array.isArray(entriesData?.entries) ? entriesData.entries : []
                      );
                      if (entriesData?.count !== undefined) {
                        console.log(
                          `✓ Loaded ${entriesData.count} audit events (${entriesData.totalEvents || 0} total)`
                        );
                      }
                      setShowAudit(true);
                    } catch (error) {
                      console.error("Failed to fetch audit logs:", error);
                      setToast("Audit data unavailable.");
                      setTimeout(() => setToast(null), 2000);
                    } finally {
                      setAuditLoading(false);
                    }
                  }}
                  disabled={auditLoading}
                >
                  {showAudit ? "Hide Audit" : auditLoading ? "Loading..." : "Audit"}
                </button>
              </>
            ) : (
              <span className="pill">Live API</span>
            )}
          </div>
        </div>
        <div className="subtitle">
          {showAudit
            ? "Audit data is for internal review only and will not be visible to traders in live mode."
            : "Guaranteed Drawdown Protection. One-Click. Premium."}
        </div>

        {!showAudit && (
          <>
            <div className="section">
              <div className="section-title-row section-gap">
                <h4>Position</h4>
                <span className="pill">
                  {portfolio?.positions?.length ? portfolio.tierName : level?.name || "—"}
                </span>
              </div>
            </div>

            <div className="stats stats-buffer">
              <div className="stat">
                <div className="label">Position PnL</div>
                <div className="value">
                  {portfolio
                    ? `${portfolioStats.totalPnl >= 0 ? "+" : "-"}$${formatUsd(
                        Math.abs(portfolioStats.totalPnl)
                      )}`
                    : "—"}
                </div>
                <div className="inline">
                  <span>Equity</span>
                  <span>{portfolio ? `$${formatUsd(mtmEquity)}` : "—"}</span>
                </div>
              </div>
              <div className="stat">
                <div className="label">Protection Floor</div>
                <div className="value">
                  {level ? `$${formatUsd(portfolioStats.floorUsd)}` : "—"}
                </div>
                <div className="inline">
                  <span>Drawdown</span>
                  <span>{level ? `${(drawdownPct * 100).toFixed(0)}%` : "—"}</span>
                </div>
              </div>
            </div>

            {portfolioError && (
              <div className="disclaimer danger">{portfolioError}</div>
            )}
          </>
        )}

        {!protectionActive && !showAudit && (
          <>
            <div className="section">
              <h4>Position</h4>
              {!portfolio || currentPositions.length === 0 ? (
                <div className="empty">Add a position to enable protection.</div>
              ) : (
                <div className="positions">
                  {currentPositions.map((p) => {
                    const isProtected = protectedIds.includes(p.id);
                    return (
                    <div className="position-row" key={p.id}>
                      <div>
                        <strong>
                          {p.asset} {p.side === "long" ? "Long" : "Short"}
                        </strong>
                        <div className="muted">
                          ${formatUsd(p.marginUsd)} • {p.leverage}x • Entry $
                          {formatPrice(p.entryPrice)}
                        </div>
                      </div>
                      <div className="position-actions">
                        <span className={p.pnl >= 0 ? "pill" : "danger"}>
                          {p.pnl >= 0 ? "+" : "-"}$
                          {formatUsd(Math.abs(p.pnl))}
                        </span>
                        <div className="position-actions-right">
                          {isProtected && <span className="pill pill-inline">Protected</span>}
                          <button
                            className={selectedIds.includes(p.id) ? "btn active" : "btn"}
                            onClick={() => toggleSelected(p.id)}
                            disabled={isProtected}
                          >
                            {isProtected
                              ? "Protected"
                              : selectedIds.includes(p.id)
                                ? "Selected"
                                : "Protect"}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                  })}
                </div>
              )}
            </div>

            <div className="section">
              <h4>Protection Summary</h4>
              <div className="recommendation">
                <div className="row row-align">
                  <span>Length</span>
                  <strong>{expiryDays} days</strong>
                </div>
                <div className="row row-align">
                  <span>Auto-renew</span>
                  <input
                    type="checkbox"
                    checked={autoRenew}
                    onChange={(e) => setAutoRenew(e.target.checked)}
                  />
                </div>
                <div className="row row-align">
                  <span>
                    Premium
                    {isFetchingQuote && (
                      <span className="fetching-status">
                        <em>Fetching<span className="fetching-dots">{fetchingDots}</span></em>
                      </span>
                    )}
                  </span>
                  <div className="row-inline row-inline-fee">
                    {pricingStatusLabel && (
                      <span className="vol-status">{pricingStatusLabel}</span>
                    )}
                    <strong className="fee-amount">{feeDisplayLabel}</strong>
                  </div>
                </div>
              </div>
              {selectedIds.length > 0 && (
                <button className="cta" onClick={handleExecute} disabled={isActivating}>
                  {isActivating && <span className="spinner" aria-hidden="true" />}
                  {isActivating ? "Activating..." : "Activate Protection"}
                </button>
              )}
              {lastExecution && <div className="disclaimer">{lastExecution}</div>}
            </div>
          </>
        )}

        {showAudit && !isMobile && (
          <AuditDashboard
            initialSummary={auditPrefetchSummary}
            initialEntries={auditPrefetchEntries}
          />
        )}

        {protectionActive && !showAudit && (
          <>
            <div className="section">
              <h4>Protection Active</h4>
              {mtmBufferLow && (
                <div className="disclaimer danger">
                  Drawdown buffer is low ({mtmBufferPct?.toFixed(2)}%). Hedge actions may trigger soon.
                </div>
              )}
              <div className="recommendation">
                <div className="row row-align">
                  <span>Tier</span>
                  <strong>{shortTierLabel()}</strong>
                </div>
                <div className="row">
                  <span>Time left</span>
                  <strong>{formatTimer(protectionExpiry)}</strong>
                </div>
                <div className="row">
                  <span>Distance to floor</span>
                  <strong>
                    ${formatUsd(Math.max(0, mtmDistanceToFloor))}
                  </strong>
                </div>
                <div className="row">
                  <span>Auto-renew</span>
                  <strong>{autoRenew ? "On" : "Off"}</strong>
                </div>
                {feeRegimeLabel &&
                  !(protectionTierName === "Pro (Bronze)" && (protectionLeverage ?? 0) <= 2) && (
                  <div className="row">
                    <span>Pricing Regime</span>
                    <strong>{feeRegimeLabel}</strong>
                  </div>
                )}
              </div>
              {!autoRenew && (
                <button className="btn" onClick={handleRenew}>
                  Renew Now
                </button>
              )}
            </div>

            <div className="section">
              <h4>Current Positions</h4>
              <div className="positions">
                {currentPositions.map((p) => (
                  <div className="position-row" key={p.id}>
                    <div>
                      <strong>
                        {p.asset} {p.side === "long" ? "Long" : "Short"}
                      </strong>
                      {protectedIds.includes(p.id) ? (
                        <span className="pill pill-inline pill-left">Protected</span>
                      ) : null}
                      <div className="muted">
                        ${formatUsd(p.marginUsd)} • {p.leverage}x • Entry $
                        {formatPrice(p.entryPrice)}
                      </div>
                    </div>
                    <div className="position-actions">
                      <span className={p.pnl >= 0 ? "pill" : "danger"}>
                        {p.pnl >= 0 ? "+" : "-"}${formatUsd(Math.abs(p.pnl))}
                      </span>
                      <div className="position-actions-right">
                        {protectedIds.includes(p.id) ? (
                          <span className="pill pill-inline">Protected</span>
                        ) : (
                          <button
                            className="btn"
                            onClick={() => {
                              setProtectionActive(false);
                              setSelectedIds([p.id]);
                            }}
                          >
                            Protect
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

      </div>

      {DATA_MODE === "demo" && portfolioOpen && (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-header">
              <div className="modal-title">
                <img
                  src="https://i.ibb.co/SDwxMqS8/Foxify-200x200.png"
                  alt="Foxify"
                />
                <h3>
                  Foxify <span className="brand-accent">Position</span>
                </h3>
                <span className="disclaimer-inline">
                  Demo mode only · Live pulls from Foxify
                </span>
              </div>
              <div className="modal-header-actions">
                <button
                  className="icon-btn"
                  onClick={() => setPortfolioOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="modal-body">
              <div className="row">
                <span>Tier</span>
                <select
                  className="input"
                  value={portfolio?.tierName || level?.name || ""}
                  onChange={(e) => {
                    const next = levels.find((item) => item.name === e.target.value) || null;
                    setLevel(next);
                    setPortfolio((prev) => ({
                      tierName: next?.name || "",
                      positions: prev?.positions || []
                    }));
                  }}
                >
                  {levels.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row row-align">
                <span>Funding</span>
                <strong>${level ? formatUsd(Number(level.funding_usdc)) : "—"}</strong>
              </div>
              <div className="row row-align">
                <span>Remaining</span>
                <strong>${formatUsd(Math.max(0, remainingMargin))}</strong>
              </div>
              <div className="divider" />
              <PortfolioForm
                levels={levels}
                level={level}
                remainingMargin={remainingMargin}
                spotPrices={spotPrices}
                existingPosition={null}
                disabled={false}
                onSave={async (position) => {
                  const nextPortfolio = {
                    tierName: portfolio?.tierName || level?.name || "Pro (Bronze)",
                    positions: [...(portfolio?.positions ?? []), position]
                  };
                  setPortfolio(nextPortfolio);
                  await syncPositions(nextPortfolio);
                }}
              />
              <div className="positions">
                {portfolio?.positions.map((p) => {
                  const isProtected = protectedIds.includes(p.id);
                  return (
                  <div className="position-row" key={p.id}>
                    <div>
                      <strong>
                        {p.asset} {p.side === "long" ? "Long" : "Short"}
                      </strong>
                      <div className="muted">
                        ${formatUsd(p.marginUsd)} • {p.leverage}x • Entry $
                        {formatPrice(p.entryPrice)}
                      </div>
                    </div>
                    <div className="position-actions">
                      <div className="position-actions-right">
                        {isProtected && <span className="pill pill-inline">Protected</span>}
                        {!isProtected && (
                          <button
                            className="btn"
                            onClick={() => {
                              setPortfolio((prev) => ({
                                tierName: prev?.tierName || "",
                                positions: prev?.positions.filter((item) => item.id !== p.id) || []
                              }));
                              setSelectedIds((prev) => (prev.includes(p.id) ? [] : prev));
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
                })}
                {portfolio?.positions.length === 0 && (
                  <div className="empty">No positions added yet.</div>
                )}
              </div>
              <div className="modal-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    if (protectionActive || hasProtectedPosition) {
                      setPortfolio((prev) =>
                        prev
                          ? {
                              ...prev,
                              positions: prev.positions.filter((item) => protectedIds.includes(item.id))
                            }
                          : prev
                      );
                      setSelectedIds((prev) => prev.filter((id) => protectedIds.includes(id)));
                      return;
                    }
                    setPortfolio(null);
                    setSelectedIds([]);
                    setProtectionActive(false);
                    setProtectedIds([]);
                    setLastCoverageId(null);
                    setProtectionTierName(null);
                    setProtectionLeverage(null);
                    localStorage.removeItem("foxify_portfolio");
                    localStorage.removeItem("foxify_protect_last");
                  }}
                >
                  Reset
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!portfolio?.positions?.length}
                  onClick={() => {
                    setPortfolioOpen(false);
                  }}
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function PortfolioForm({
  levels,
  level,
  remainingMargin,
  spotPrices,
  existingPosition,
  disabled,
  onSave
}: {
  levels: FundedLevel[];
  level: FundedLevel | null;
  remainingMargin: number;
  spotPrices: Record<Asset, number | null>;
  existingPosition: PortfolioPosition | null;
  disabled?: boolean;
  onSave: (position: PortfolioPosition) => void;
}) {
  const [asset, setAsset] = useState<Asset>(existingPosition?.asset || "BTC");
  const [side, setSide] = useState<"long" | "short">(existingPosition?.side || "long");
  const [marginUsd, setMarginUsd] = useState(existingPosition?.marginUsd || 500);
  const [leverage, setLeverage] = useState(existingPosition?.leverage || 1);
  const autoSaveTimerRef = useRef<number | null>(null);
  const autoSaveInitRef = useRef(false);
  const spot = spotPrices[asset] || 0;

  useEffect(() => {
    if (!existingPosition) return;
    setAsset(existingPosition.asset);
    setSide(existingPosition.side);
    setMarginUsd(existingPosition.marginUsd);
    setLeverage(existingPosition.leverage);
    autoSaveInitRef.current = false;
  }, [existingPosition?.id]);

  const availableMargin = remainingMargin + (existingPosition?.marginUsd || 0);
  const canSave =
    !disabled &&
    level &&
    marginUsd > 0 &&
    marginUsd <= availableMargin &&
    leverage >= 1 &&
    leverage <= 10 &&
    spot > 0;

  useEffect(() => {
    if (!existingPosition) return;
    if (disabled) return;
    if (!canSave) return;
    if (!autoSaveInitRef.current) {
      autoSaveInitRef.current = true;
      return;
    }
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = window.setTimeout(() => {
      onSave({
        id: existingPosition.id,
        asset,
        side,
        marginUsd,
        leverage,
        entryPrice: spot
      });
    }, 300);
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [asset, side, marginUsd, leverage, spot, canSave, existingPosition?.id]);

  return (
    <div className="recommendation">
      <div className="row">
        <span>Asset</span>
        <select
          className="input"
          value={asset}
          onChange={(e) => setAsset(e.target.value as Asset)}
          disabled={disabled}
        >
          {ASSETS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <span>Side</span>
        <select
          className="input"
          value={side}
          onChange={(e) => setSide(e.target.value as "long" | "short")}
          disabled={disabled}
        >
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
      </div>
      <div className="row">
        <span>Margin (USD)</span>
        <input
          className="input"
          type="number"
          min="0"
          step="50"
          value={marginUsd}
          onChange={(e) => setMarginUsd(Number(e.target.value || 0))}
          disabled={disabled}
        />
      </div>
      <div className="row">
        <span>Leverage</span>
        <input
          className="input"
          type="number"
          min="1"
          max="10"
          step="1"
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value || 1))}
          disabled={disabled}
        />
      </div>
      <div className="row">
        <span>Entry</span>
        <strong>{spot ? `$${formatSpotPrice(spot)}` : "—"}</strong>
      </div>
      {!existingPosition && (
        <button
          className="btn btn-primary add-position"
          onClick={() => {
            if (!canSave) return;
            onSave({
              id: Math.random().toString(36).slice(2, 10),
              asset,
              side,
              marginUsd,
              leverage,
              entryPrice: spot
            });
          }}
          disabled={!canSave}
        >
          Add Position
        </button>
      )}
    </div>
  );
}

function validatePortfolio(input: unknown): PortfolioValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Portfolio response is not an object." };
  }
  const value = input as { tierName?: unknown; positions?: unknown };
  if (typeof value.tierName !== "string" || value.tierName.length === 0) {
    return { ok: false, error: "Missing or invalid tierName." };
  }
  if (!Array.isArray(value.positions)) {
    return { ok: false, error: "Positions must be an array." };
  }
  const positions: PortfolioPosition[] = [];
  for (const item of value.positions) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Position entry is invalid." };
    }
    const pos = item as {
      id?: unknown;
      asset?: unknown;
      side?: unknown;
      marginUsd?: unknown;
      leverage?: unknown;
      entryPrice?: unknown;
    };
    if (typeof pos.id !== "string" || pos.id.length === 0) {
      return { ok: false, error: "Position missing id." };
    }
    if (!ASSETS.includes(pos.asset as Asset)) {
      return { ok: false, error: "Position asset is invalid." };
    }
    if (pos.side !== "long" && pos.side !== "short") {
      return { ok: false, error: "Position side must be long or short." };
    }
    const marginUsd = Number(pos.marginUsd);
    const leverage = Number(pos.leverage);
    const entryPrice = Number(pos.entryPrice);
    if (!Number.isFinite(marginUsd) || marginUsd <= 0) {
      return { ok: false, error: "Position marginUsd is invalid." };
    }
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 10) {
      return { ok: false, error: "Position leverage is invalid." };
    }
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return { ok: false, error: "Position entryPrice is invalid." };
    }
    positions.push({
      id: pos.id,
      asset: pos.asset as Asset,
      side: pos.side as "long" | "short",
      marginUsd,
      leverage,
      entryPrice
    });
  }
  return { ok: true, value: { tierName: value.tierName, positions } };
}
