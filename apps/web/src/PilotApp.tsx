import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, PILOT_TERMS_VERSION } from "./config";

type TierLevel = {
  name: string;
  drawdownFloorPct: number;
  expiryDays: number;
  renewWindowMinutes: number;
};

type ProtectionType = "long" | "short";

type QuoteResult = {
  protectionType?: ProtectionType;
  tierName: string;
  drawdownFloorPct: string;
  floorPrice: string;
  triggerPrice?: string;
  triggerLabel?: string;
  quote: {
    quoteId: string;
    instrumentId: string;
    premium: number;
    expiresAt: string;
    quantity: number;
    venue: string;
  };
  entrySnapshot: {
    price: string;
    marketId?: string;
    source: string;
    timestamp: string;
    requestId?: string;
  };
  entryInputPrice?: string | null;
  limits?: {
    maxProtectionNotionalUsdc: string;
    maxDailyProtectedNotionalUsdc: string;
    dailyUsedUsdc: string;
    projectedDailyUsdc: string;
    dailyCapExceededOnActivate: boolean;
  };
};

type MonitorPayload = {
  protectionId: string;
  status: string;
  protectionType: ProtectionType;
  referencePrice: string;
  referenceSource: string;
  referenceTimestamp: string;
  triggerPrice: string;
  distanceToTriggerPct: string;
  optionMarkUsd: string;
  markSource: string;
  markDetails?: Record<string, unknown> | null;
  estimatedTriggerValue: string;
  asOf: string;
};

type ReferencePricePayload = {
  status: "ok" | "error";
  reference?: {
    price: string;
    marketId: string;
    venue?: string;
    source: string;
    timestamp: string;
    requestId?: string;
    ageMs?: number;
    freshnessMaxMs?: number;
  };
  reason?: string;
  message?: string;
};

type AdminProtectionRow = {
  protection_id: string;
  status: string;
  tier_name: string | null;
  drawdown_floor_pct: string | null;
  created_at: string;
  expiry_at: string;
  market_id: string;
  entry_price: string | null;
  floor_price: string | null;
  expiry_price: string | null;
  protected_notional: string;
  premium: string | null;
  payout_due_amount: string | null;
  payout_settled_amount: string | null;
  venue: string | null;
  instrument_id: string | null;
  external_order_id: string | null;
  external_execution_id: string | null;
};

type AdminLedgerEntry = {
  id: string;
  entryType: string;
  amount: string;
  currency: string;
  reference: string | null;
  createdAt: string;
  settledAt: string | null;
};

type AdminMetrics = {
  totalProtections: string;
  activeProtections: string;
  protectedNotionalTotalUsdc: string;
  protectedNotionalActiveUsdc: string;
  clientPremiumTotalUsdc: string;
  hedgePremiumTotalUsdc: string;
  bookedMarginUsdc: string;
  bookedMarginPct: string;
  premiumDueTotalUsdc: string;
  premiumSettledTotalUsdc: string;
  payoutDueTotalUsdc: string;
  payoutSettledTotalUsdc: string;
  pendingPremiumReceivableUsdc: string;
  openPayoutLiabilityUsdc: string;
  startingReserveUsdc: string;
  availableReserveUsdc: string;
  reserveAfterOpenPayoutLiabilityUsdc: string;
  netSettledCashUsdc: string;
};

type AdminExportPagination = {
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
};

type ProtectionRecord = {
  id: string;
  status: string;
  tierName: string | null;
  drawdownFloorPct: string | null;
  floorPrice: string | null;
  protectedNotional: string;
  foxifyExposureNotional: string;
  entryPrice: string | null;
  expiryAt: string;
  premium: string | null;
  autoRenew: boolean;
  renewWindowMinutes: number;
  venue: string | null;
  metadata?: Record<string, unknown> | null;
};

type PilotTermsStatusResponse = {
  status: "ok" | "error";
  accepted?: boolean;
  acceptedAt?: string | null;
  termsVersion?: string;
  reason?: string;
  message?: string;
};

const formatUsd = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0.00";
  return parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const DEFAULT_TIERS: TierLevel[] = [
  { name: "Pro (Bronze)", drawdownFloorPct: 0.2, expiryDays: 7, renewWindowMinutes: 1440 },
  { name: "Pro (Silver)", drawdownFloorPct: 0.15, expiryDays: 7, renewWindowMinutes: 1440 },
  { name: "Pro (Gold)", drawdownFloorPct: 0.12, expiryDays: 7, renewWindowMinutes: 1440 },
  { name: "Pro (Platinum)", drawdownFloorPct: 0.12, expiryDays: 7, renewWindowMinutes: 1440 }
];

const formatPct = (value: number | string | null | undefined): string => {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0.00%";
  return `${(parsed * 100).toFixed(2)}%`;
};

const formatCurrencyInput = (value: string): string => {
  const cleaned = value.replace(/,/g, "").replace(/[^\d.]/g, "");
  if (!cleaned) return "";
  const [wholeRaw, ...fractionParts] = cleaned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "");
  const grouped = (whole || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fractionParts.length === 0) return grouped;
  const fraction = fractionParts.join("").slice(0, 8);
  return `${grouped}.${fraction}`;
};

const parseCurrencyNumber = (value: string): number => {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
};

const formatCountdown = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const friendlyError = (message: string): string => {
  if (message.includes("daily_notional_cap_exceeded")) {
    return "Daily protection limit reached for pilot operations. Please try again next UTC day.";
  }
  if (message.includes("protection_notional_cap_exceeded")) {
    return "Protection amount exceeds the pilot maximum. Reduce amount and request a new quote.";
  }
  if (message.includes("quote_expired")) {
    return "Quote expired. Request a fresh quote and confirm again.";
  }
  if (message.includes("quote_not_found")) {
    return "Quote is no longer available. Tap Refresh Quote.";
  }
  if (message.includes("quote_mismatch")) {
    return "Protection terms changed after quoting. Request a new quote before confirming.";
  }
  if (message.includes("price_unavailable")) {
    return "Quote temporarily unavailable. Tap Refresh Quote.";
  }
  if (message.includes("storage_unavailable")) {
    return "Quote temporarily unavailable. Tap Refresh Quote.";
  }
  if (message.includes("quote_generation_failed")) {
    return "Quote temporarily unavailable. Tap Refresh Quote.";
  }
  if (message.includes("venue_quote_timeout")) {
    return "Quote is taking longer than expected. Tap Refresh Quote.";
  }
  if (message.includes("venue_execute_timeout")) {
    return "Activation is taking longer than expected. Tap Confirm Protection again.";
  }
  if (message.includes("full_coverage_not_met")) {
    return "Coverage check changed. Tap Refresh Quote and confirm again.";
  }
  if (message.includes("activation_failed")) {
    return "Activation could not be confirmed yet. Tap Confirm Protection again.";
  }
  if (message.toLowerCase().includes("failed to fetch")) {
    return "Network issue detected. Please retry.";
  }
  if (message.includes("admin_unauthorized") || message.includes("unauthorized")) {
    return "Admin access denied. Use a valid internal admin token.";
  }
  return "Unable to complete request. Please retry.";
};

const isPriceUnavailableError = (message: string | null): boolean =>
  Boolean(message && message.toLowerCase().includes("quote temporarily unavailable"));

const isRetryableQuoteError = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("price_unavailable") ||
    lower.includes("quote_generation_failed") ||
    lower.includes("venue_quote_timeout") ||
    lower.includes("storage_unavailable") ||
    lower.includes("fetch failed")
  );
};

const isRetryableActivationError = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("venue_execute_timeout") ||
    lower.includes("storage_unavailable") ||
    lower.includes("price_unavailable") ||
    lower.includes("activation_failed") ||
    lower.includes("fetch failed")
  );
};

const formatVenueLabel = (venue: string | null | undefined): string => {
  const normalized = String(venue || "").trim().toLowerCase();
  if (normalized === "deribit_test") return "Deribit Test";
  if (normalized === "falconx") return "FalconX Live";
  if (normalized === "mock_falconx") return "Mock FalconX";
  return normalized || "Unknown";
};

const toTermsVersionDisplay = (rawVersion: string): string => {
  const normalized = String(rawVersion || "").trim();
  const match = normalized.match(/^v?(\d+)(?:\.(\d+))?/i);
  if (!match) return "v1.0";
  const major = match[1] || "1";
  const minor = (match[2] || "0").charAt(0) || "0";
  return `v${major}.${minor}`;
};

const PILOT_TERMS_VERSION_DISPLAY = toTermsVersionDisplay(PILOT_TERMS_VERSION);

const FOXIFY_LOGO_URL = "https://i.ibb.co/SDwxMqS8/Foxify-200x200.png";
const ATTICUS_LOGO_URL = "https://i.ibb.co/KpbRyd7w/atticus-copy.png";
const PILOT_SUPPORT_EMAIL = "michael@atticustrade.com";
const PILOT_SUPPORT_TELEGRAM = "@willialso";

export function PilotApp() {
  const termsLocalStorageKey = `pilot_terms_accepted_${PILOT_TERMS_VERSION}`;
  const [pilotUnlocked, setPilotUnlocked] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(termsLocalStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const [termsStatus, setTermsStatus] = useState<"checking" | "required" | "accepted">("checking");
  const [termsBusy, setTermsBusy] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [termsModalOpen, setTermsModalOpen] = useState(false);
  const [termsChecked, setTermsChecked] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(termsLocalStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const [foxifyLogoFailed, setFoxifyLogoFailed] = useState(false);
  const [atticusLogoFailed, setAtticusLogoFailed] = useState(false);
  const [tiers, setTiers] = useState<TierLevel[]>(DEFAULT_TIERS);
  const [tierName, setTierName] = useState(DEFAULT_TIERS[0].name);
  const [protectionType, setProtectionType] = useState<ProtectionType>("long");
  const [exposureNotional, setExposureNotional] = useState("");
  const [protectedNotional, setProtectedNotional] = useState("");
  const [entryPrice, setEntryPrice] = useState("");
  const [autoRenew, setAutoRenew] = useState(false);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [protection, setProtection] = useState<ProtectionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quoteState, setQuoteState] = useState<"idle" | "fetching" | "ready" | "expired">("idle");
  const [quoteTimeLeft, setQuoteTimeLeft] = useState(0);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [showProtectionModal, setShowProtectionModal] = useState(false);
  const [monitor, setMonitor] = useState<MonitorPayload | null>(null);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [protectionsHistory, setProtectionsHistory] = useState<ProtectionRecord[]>([]);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminRows, setAdminRows] = useState<AdminProtectionRow[]>([]);
  const [adminPagination, setAdminPagination] = useState<AdminExportPagination>({
    total: 0,
    limit: 20,
    offset: 0,
    nextOffset: null
  });
  const [adminSelectedId, setAdminSelectedId] = useState<string | null>(null);
  const [adminLedger, setAdminLedger] = useState<AdminLedgerEntry[]>([]);
  const [adminDetailProtection, setAdminDetailProtection] = useState<ProtectionRecord | null>(null);
  const [adminMonitor, setAdminMonitor] = useState<MonitorPayload | null>(null);
  const [adminMetrics, setAdminMetrics] = useState<AdminMetrics | null>(null);
  const [adminViewingId, setAdminViewingId] = useState<string | null>(null);
  const [showAdminDetailModal, setShowAdminDetailModal] = useState(false);
  const [adminDetailUpdatedAt, setAdminDetailUpdatedAt] = useState<Date | null>(null);
  const [adminDownloadingReconciliation, setAdminDownloadingReconciliation] = useState(false);
  const [showHistorySection, setShowHistorySection] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [liveReference, setLiveReference] = useState<ReferencePricePayload["reference"] | null>(null);
  const [liveReferenceBusy, setLiveReferenceBusy] = useState(false);
  const [liveReferenceError, setLiveReferenceError] = useState<string | null>(null);
  const historyRequestSeqRef = useRef(0);
  const monitorRequestSeqRef = useRef(0);
  const protectionPollSeqRef = useRef(0);
  const selectedTier = useMemo(
    () => tiers.find((tier) => tier.name === tierName) || DEFAULT_TIERS[0],
    [tierName, tiers]
  );

  const exposureValue = parseCurrencyNumber(exposureNotional || "0");
  const protectedValue = parseCurrencyNumber(protectedNotional || "0");
  const entryValue = parseCurrencyNumber(entryPrice || "0");
  const canQuote =
    pilotUnlocked &&
    Number.isFinite(exposureValue) &&
    exposureValue > 0 &&
    Number.isFinite(protectedValue) &&
    protectedValue > 0 &&
    protectedValue <= exposureValue;
  const quoteFresh =
    quoteState === "ready" && quote?.quote?.expiresAt ? Date.parse(quote.quote.expiresAt) > Date.now() : false;
  const quoteLocked = quoteFresh && Boolean(quote?.quote?.quoteId);
  const quoteCapWarning = quote?.limits?.dailyCapExceededOnActivate === true;
  const canActivate = canQuote && Boolean(quote?.quote?.quoteId) && quoteFresh && !quoteCapWarning;

  const renewWindowReached = useMemo(() => {
    if (!protection || protection.autoRenew || protection.status !== "active") return false;
    const expiryMs = Date.parse(protection.expiryAt);
    if (!Number.isFinite(expiryMs)) return false;
    const renewAtMs = expiryMs - protection.renewWindowMinutes * 60 * 1000;
    return Date.now() >= renewAtMs;
  }, [protection]);

  useEffect(() => {
    if (renewWindowReached) {
      setShowRenewModal(true);
    }
  }, [renewWindowReached]);

  useEffect(() => {
    let active = true;
    const loadTiers = async () => {
      try {
        const res = await fetch("/funded_levels.json");
        if (!res.ok) return;
        const payload = (await res.json()) as { levels?: Array<Record<string, unknown>> };
        const parsed = (payload.levels || [])
          .map((item) => {
            const name = typeof item.name === "string" ? item.name : "";
            const drawdown = Number(item.drawdown_limit_pct ?? 0);
            const expiryDays = Number(item.expiry_days ?? 7);
            const renewWindowMinutes = Number(item.renew_window_minutes ?? 1440);
            if (!name || !Number.isFinite(drawdown) || drawdown <= 0) return null;
            return {
              name,
              drawdownFloorPct: drawdown,
              expiryDays: Number.isFinite(expiryDays) && expiryDays > 0 ? Math.floor(expiryDays) : 7,
              renewWindowMinutes:
                Number.isFinite(renewWindowMinutes) && renewWindowMinutes > 0
                  ? Math.floor(renewWindowMinutes)
                  : 1440
            } as TierLevel;
          })
          .filter((item): item is TierLevel => Boolean(item));
        if (!active || parsed.length === 0) return;
        setTiers(parsed);
        if (!parsed.some((tier) => tier.name === tierName)) {
          setTierName(parsed[0].name);
        }
      } catch {
        // keep defaults on tier fetch failure
      }
    };
    loadTiers();
    return () => {
      active = false;
    };
  }, [tierName]);

  useEffect(() => {
    setQuote(null);
    setQuoteState("idle");
    setQuoteTimeLeft(0);
  }, [protectionType, selectedTier.name, selectedTier.drawdownFloorPct, exposureNotional, protectedNotional]);

  useEffect(() => {
    setTermsError(null);
    let cancelled = false;
    const controller = new AbortController();
    setTermsStatus("checking");
    const loadTermsStatus = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/pilot/terms/status?termsVersion=${encodeURIComponent(PILOT_TERMS_VERSION)}`,
          { signal: controller.signal }
        );
        const payload = (await res.json()) as PilotTermsStatusResponse;
        if (cancelled) return;
        if (!res.ok || payload.status !== "ok") {
          throw new Error(payload.reason || payload.message || "terms_status_failed");
        }
        if (payload.accepted) {
          setTermsStatus("accepted");
          setTermsChecked(true);
          setPilotUnlocked(true);
          if (typeof window !== "undefined") {
            try {
              window.localStorage.setItem(termsLocalStorageKey, "1");
            } catch {
              // best-effort cache only
            }
          }
          return;
        }
        setTermsStatus("required");
        setTermsChecked(false);
        setPilotUnlocked(false);
        if (typeof window !== "undefined") {
          try {
            window.localStorage.removeItem(termsLocalStorageKey);
          } catch {
            // best-effort cache only
          }
        }
      } catch (error: any) {
        if (cancelled || error?.name === "AbortError") return;
        setTermsStatus("required");
        const locallyAccepted = (() => {
          if (typeof window === "undefined") return false;
          try {
            return window.localStorage.getItem(termsLocalStorageKey) === "1";
          } catch {
            return false;
          }
        })();
        if (!locallyAccepted) {
          setTermsChecked(false);
          setPilotUnlocked(false);
        }
        setTermsError("Unable to verify terms right now. You can still continue after confirming acceptance.");
      }
    };
    void loadTermsStatus();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [termsLocalStorageKey]);

  useEffect(() => {
    if (!pilotUnlocked) {
      setLiveReference(null);
      setLiveReferenceBusy(false);
      setLiveReferenceError(null);
      return;
    }
    let active = true;
    const loadReference = async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true;
      if (!silent) {
        setLiveReferenceBusy(true);
      }
      try {
        const res = await fetch(`${API_BASE}/pilot/reference-price?marketId=BTC-USD`);
        const payload = (await res.json()) as ReferencePricePayload;
        if (!active) return;
        if (!res.ok || payload.status !== "ok" || !payload.reference) {
          throw new Error(payload.reason || payload.message || "price_unavailable");
        }
        setLiveReference(payload.reference);
        setLiveReferenceError(null);
      } catch (error: any) {
        if (!active) return;
        setLiveReferenceError(friendlyError(String(error?.message || "price_unavailable")));
      } finally {
        if (!silent && active) {
          setLiveReferenceBusy(false);
        }
      }
    };
    void loadReference();
    const id = setInterval(() => {
      void loadReference({ silent: true });
    }, 10000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [pilotUnlocked]);

  useEffect(() => {
    if (!quote?.quote?.expiresAt) {
      setQuoteTimeLeft(0);
      return;
    }
    const updateTime = () => {
      const seconds = Math.max(0, Math.ceil((Date.parse(quote.quote.expiresAt) - Date.now()) / 1000));
      setQuoteTimeLeft(seconds);
      if (seconds <= 0) {
        setQuoteState("expired");
      } else if (quoteState !== "fetching") {
        setQuoteState("ready");
      }
    };
    updateTime();
    const id = setInterval(updateTime, 1000);
    return () => clearInterval(id);
  }, [quote?.quote?.expiresAt, quoteState]);

  useEffect(() => {
    if (!protection?.id) return;
    const polledProtectionId = protection.id;
    const pollSeq = ++protectionPollSeqRef.current;
    const pollProtection = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/pilot/protections/${polledProtectionId}`
        );
        if (!res.ok) return;
        const payload = await res.json();
        if (protectionPollSeqRef.current !== pollSeq) return;
        if (payload?.protection && payload.protection.id === polledProtectionId) {
          setProtection(payload.protection as ProtectionRecord);
          setLastUpdatedAt(new Date());
        }
      } catch {
        // ignore polling errors in pilot widget
      }
    };
    void pollProtection();
    const id = setInterval(() => {
      void pollProtection();
    }, 10000);
    return () => {
      clearInterval(id);
      protectionPollSeqRef.current += 1;
    };
  }, [protection?.id, pilotUnlocked]);

  const refreshProtectionHistory = async (opts?: { clearExisting?: boolean; silent?: boolean }) => {
    const requestSeq = ++historyRequestSeqRef.current;
    const clearExisting = opts?.clearExisting === true;
    const silent = opts?.silent === true;
    if (!silent) {
      setHistoryBusy(true);
    }
    if (clearExisting) {
      setProtectionsHistory([]);
    }
    if (!pilotUnlocked) {
      if (requestSeq === historyRequestSeqRef.current) {
        setProtectionsHistory([]);
        if (!silent) setHistoryBusy(false);
      }
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/pilot/protections?limit=20`);
      if (!res.ok) return;
      const payload = await res.json();
      if (requestSeq !== historyRequestSeqRef.current) return;
      if (Array.isArray(payload?.protections)) {
        setProtectionsHistory(payload.protections as ProtectionRecord[]);
      }
    } catch {
      // ignore history refresh errors in pilot widget
    } finally {
      if (!silent && requestSeq === historyRequestSeqRef.current) {
        setHistoryBusy(false);
      }
    }
  };

  const refreshMonitor = async (protectionId: string) => {
    const requestSeq = ++monitorRequestSeqRef.current;
    setMonitorBusy(true);
    try {
      const res = await fetch(
        `${API_BASE}/pilot/protections/${protectionId}/monitor`
      );
      if (!res.ok) return;
      const payload = await res.json();
      if (requestSeq !== monitorRequestSeqRef.current) return;
      if (payload?.monitor && payload.monitor.protectionId === protectionId) {
        setMonitor(payload.monitor as MonitorPayload);
        setLastUpdatedAt(new Date());
      }
    } catch {
      // ignore monitor refresh errors in pilot widget
    } finally {
      if (requestSeq === monitorRequestSeqRef.current) {
        setMonitorBusy(false);
      }
    }
  };

  const loadAdminRows = async (token: string, pageOffset = 0) => {
    setAdminBusy(true);
    setAdminError(null);
    const pageSize = adminPagination.limit > 0 ? adminPagination.limit : 20;
    const normalizedOffset = Math.max(0, Math.floor(pageOffset));
    try {
      const [rowsRes, metricsRes] = await Promise.all([
        fetch(`${API_BASE}/pilot/protections/export?format=json&limit=${pageSize}&offset=${normalizedOffset}`, {
          headers: { "x-admin-token": token }
        }),
        fetch(`${API_BASE}/pilot/admin/metrics`, {
          headers: { "x-admin-token": token }
        })
      ]);
      const rowsPayload = await rowsRes.json();
      const metricsPayload = await metricsRes.json();
      if (!rowsRes.ok || rowsPayload?.status !== "ok" || !Array.isArray(rowsPayload?.rows)) {
        throw new Error(rowsPayload?.reason || "admin_load_failed");
      }
      if (!metricsRes.ok || metricsPayload?.status !== "ok" || !metricsPayload?.metrics) {
        throw new Error(metricsPayload?.reason || "admin_metrics_failed");
      }
      const rows = rowsPayload.rows as AdminProtectionRow[];
      const paginationPayload = (rowsPayload?.pagination || {}) as Partial<AdminExportPagination>;
      setAdminRows(rows);
      setAdminPagination({
        total: Number(paginationPayload.total ?? rows.length ?? 0),
        limit: Number(paginationPayload.limit ?? pageSize),
        offset: Number(paginationPayload.offset ?? normalizedOffset),
        nextOffset:
          paginationPayload.nextOffset === null || paginationPayload.nextOffset === undefined
            ? null
            : Number(paginationPayload.nextOffset)
      });
      setAdminMetrics(metricsPayload.metrics as AdminMetrics);
      const nextSelected = adminSelectedId && rows.some((row) => row.protection_id === adminSelectedId)
        ? adminSelectedId
        : rows[0]?.protection_id || null;
      setAdminSelectedId(nextSelected);
      if (nextSelected) {
        await refreshAdminSelection(nextSelected, token);
      }
      setAdminToken(token);
    } catch (err: any) {
      setAdminError(friendlyError(String(err?.message || "admin_load_failed")));
    } finally {
      setAdminBusy(false);
    }
  };

  const downloadReconciliationCsv = async (token: string) => {
    setAdminDownloadingReconciliation(true);
    setAdminError(null);
    try {
      const res = await fetch(`${API_BASE}/pilot/admin/reconciliation/export?format=csv&limit=1000&offset=0`, {
        headers: { "x-admin-token": token }
      });
      if (!res.ok) {
        let reason = "reconciliation_export_failed";
        try {
          const payload = await res.json();
          reason = String(payload?.reason || reason);
        } catch {
          // continue with fallback reason
        }
        throw new Error(reason);
      }
      const csv = await res.text();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pilot-reconciliation-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setAdminError(friendlyError(String(err?.message || "reconciliation_export_failed")));
    } finally {
      setAdminDownloadingReconciliation(false);
    }
  };

  const refreshAdminSelection = async (protectionId: string, token: string) => {
    setAdminBusy(true);
    setAdminError(null);
    setAdminViewingId(protectionId);
    try {
      const [ledgerRes, monitorRes] = await Promise.all([
        fetch(`${API_BASE}/pilot/admin/protections/${protectionId}/ledger`, {
          headers: { "x-admin-token": token }
        }),
        fetch(`${API_BASE}/pilot/protections/${protectionId}/monitor`, {
          headers: { "x-admin-token": token }
        })
      ]);
      const ledgerPayload = await ledgerRes.json();
      const monitorPayload = await monitorRes.json();
      if (!ledgerRes.ok || ledgerPayload?.status !== "ok") {
        throw new Error(ledgerPayload?.reason || "admin_ledger_failed");
      }
      setAdminDetailProtection((ledgerPayload?.protection as ProtectionRecord) || null);
      setAdminLedger(Array.isArray(ledgerPayload?.ledger) ? (ledgerPayload.ledger as AdminLedgerEntry[]) : []);
      setAdminMonitor(monitorPayload?.monitor ? (monitorPayload.monitor as MonitorPayload) : null);
      setAdminDetailUpdatedAt(new Date());
    } catch (err: any) {
      setAdminError(friendlyError(String(err?.message || "admin_refresh_failed")));
    } finally {
      setAdminBusy(false);
      setAdminViewingId(null);
    }
  };

  useEffect(() => {
    void refreshProtectionHistory({ clearExisting: true });
  }, [pilotUnlocked]);

  useEffect(() => {
    setMonitor(null);
  }, [protection?.id]);

  useEffect(() => {
    if (!showProtectionModal || !protection?.id) return;
    void refreshMonitor(protection.id);
    const id = setInterval(() => {
      void refreshMonitor(protection.id);
    }, 10000);
    return () => clearInterval(id);
  }, [showProtectionModal, protection?.id, pilotUnlocked]);

  useEffect(() => {
    if (!showAdminModal) {
      setShowAdminDetailModal(false);
    }
  }, [showAdminModal]);

  const requestQuote = async () => {
    if (!canQuote) return;
    setBusy(true);
    setError(null);
    setQuote(null);
    setQuoteState("fetching");
    const maxAttempts = 3;
    let finalError: any = null;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
          const res = await fetch(`${API_BASE}/pilot/protections/quote`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              protectedNotional: protectedValue,
              foxifyExposureNotional: exposureValue,
              protectionType,
              instrumentId: `BTC-USD-7D-${protectionType === "short" ? "C" : "P"}`,
              marketId: "BTC-USD",
              tierName: selectedTier.name,
              drawdownFloorPct: selectedTier.drawdownFloorPct,
              ...(Number.isFinite(entryValue) && entryValue > 0 ? { entryPrice: entryValue } : {})
            })
          });
          const payload = await res.json();
          if (!res.ok || payload?.status !== "ok") {
            const reason = String(payload?.reason || "");
            const detail = String(payload?.detail || "");
            if (reason === "price_unavailable") {
              throw new Error(`price_unavailable${detail ? `:${detail}` : ""}`);
            }
            throw new Error(payload?.message || reason || "quote_failed");
          }
          setQuote(payload as QuoteResult);
          setQuoteState("ready");
          return;
        } catch (err: any) {
          finalError = err;
          const retryable =
            err?.name === "AbortError" || isRetryableQuoteError(String(err?.message || "quote_failed"));
          if (attempt < maxAttempts && retryable) {
            await new Promise((resolve) => setTimeout(resolve, 450));
            continue;
          }
          break;
        } finally {
          clearTimeout(timeout);
        }
      }
      setQuoteState("idle");
      const err = finalError;
      if (err?.name === "AbortError") {
        setError("Quote is taking longer than expected. Tap Refresh Quote.");
      } else {
        setError(friendlyError(String(err?.message || "Price temporarily unavailable, please retry.")));
      }
    } finally {
      setBusy(false);
    }
  };

  const activateProtection = async () => {
    if (!canActivate) {
      setError("Get a fresh quote before activation.");
      return;
    }
    setBusy(true);
    setError(null);
    let finalError: any = null;
    const maxAttempts = 2;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(`${API_BASE}/pilot/protections/activate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              protectedNotional: protectedValue,
              foxifyExposureNotional: exposureValue,
              protectionType,
              instrumentId: `BTC-USD-7D-${protectionType === "short" ? "C" : "P"}`,
              marketId: "BTC-USD",
              tierName: selectedTier.name,
              drawdownFloorPct: selectedTier.drawdownFloorPct,
              tenorDays: selectedTier.expiryDays,
              renewWindowMinutes: selectedTier.renewWindowMinutes,
              autoRenew,
              quoteId: quote?.quote?.quoteId,
              ...(Number.isFinite(entryValue) && entryValue > 0 ? { entryPrice: entryValue } : {})
            })
          });
          const payload = await res.json();
          if (!res.ok || payload?.status !== "ok") {
            const reason = String(payload?.reason || "");
            const message = String(payload?.message || "");
            throw new Error([reason, message].filter(Boolean).join(":") || "activation_failed");
          }
          setProtection(payload.protection as ProtectionRecord);
          setMonitor(null);
          setLastUpdatedAt(new Date());
          setShowProtectionModal(true);
          setShowRenewModal(false);
          void refreshProtectionHistory({ silent: true });
          return;
        } catch (err: any) {
          finalError = err;
          const errMsg = String(err?.message || "activation_failed");
          const retryable = err?.name === "AbortError" || isRetryableActivationError(errMsg);
          if (attempt < maxAttempts && retryable) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          break;
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      const err = finalError;
      if (err) {
        if (err?.name === "AbortError") {
          setError("Activation is taking longer than expected. Please retry.");
        } else {
          setError(friendlyError(String(err?.message || "activation_failed")));
        }
      }
      setBusy(false);
    }
  };

  const submitRenewDecision = async (decision: "renew" | "expire") => {
    if (!protection?.id) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/pilot/protections/${protection.id}/renewal-decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision })
      });
      const payload = await res.json();
      if (!res.ok || payload?.status !== "ok") {
        throw new Error(payload?.reason || "renewal_decision_failed");
      }
      if (payload?.protection) {
        setProtection(payload.protection as ProtectionRecord);
      }
      setShowRenewModal(false);
      void refreshProtectionHistory({ silent: true });
    } catch (err: any) {
      setError(friendlyError(String(err?.message || "Failed to process renewal decision.")));
    } finally {
      setBusy(false);
    }
  };

  const canContinuePastGate =
    !termsBusy &&
    termsStatus !== "checking" &&
    (termsStatus === "accepted" || termsChecked);

  const acceptTermsAndContinue = async () => {
    if (termsStatus === "accepted") {
      setPilotUnlocked(true);
      return;
    }
    if (!termsChecked) {
      setTermsError("Check the acknowledgement box to continue.");
      return;
    }
    setTermsBusy(true);
    setTermsError(null);
    try {
      const res = await fetch(`${API_BASE}/pilot/terms/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          termsVersion: PILOT_TERMS_VERSION,
          accepted: true
        })
      });
      const payload = (await res.json()) as {
        status?: "ok" | "error";
        acceptedAt?: string;
        reason?: string;
        message?: string;
      };
      if (!res.ok || payload?.status !== "ok") {
        throw new Error(payload?.reason || payload?.message || "terms_accept_failed");
      }
      setTermsStatus("accepted");
      setPilotUnlocked(true);
      setTermsChecked(true);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(termsLocalStorageKey, "1");
        } catch {
          // best-effort cache only
        }
      }
    } catch (error: any) {
      setTermsError(friendlyError(String(error?.message || "terms_accept_failed")));
    } finally {
      setTermsBusy(false);
    }
  };

  const metadataProtectionType =
    protection?.metadata && typeof protection.metadata["protectionType"] === "string"
      ? ((protection.metadata["protectionType"] as string).toLowerCase() === "short" ? "short" : "long")
      : null;
  const effectiveProtectionType: ProtectionType = metadataProtectionType ?? quote?.protectionType ?? protectionType;
  const displayedDrawdownPct =
    Number(protection?.drawdownFloorPct ?? quote?.drawdownFloorPct ?? selectedTier.drawdownFloorPct);
  const displayedTriggerPrice =
    protection?.floorPrice ??
    quote?.triggerPrice ??
    quote?.floorPrice ??
    null;
  const metadataEntrySnapshotPrice =
    protection?.metadata && typeof protection.metadata["entrySnapshotPrice"] === "string"
      ? (protection.metadata["entrySnapshotPrice"] as string)
      : null;
  const liveReferenceNumber = Number(liveReference?.price ?? NaN);
  const liveReferenceAgeMs = Number(liveReference?.ageMs ?? NaN);
  const liveReferenceFreshnessMs = Number(liveReference?.freshnessMaxMs ?? NaN);
  const liveReferenceStale =
    Number.isFinite(liveReferenceAgeMs) &&
    Number.isFinite(liveReferenceFreshnessMs) &&
    liveReferenceFreshnessMs > 0 &&
    liveReferenceAgeMs > liveReferenceFreshnessMs;
  const referencePrice =
    Number(metadataEntrySnapshotPrice ?? quote?.entrySnapshot?.price ?? protection?.entryPrice ?? liveReference?.price ?? NaN);
  const triggerNumber = Number(displayedTriggerPrice ?? 0);
  const distanceToTriggerPct =
    Number.isFinite(referencePrice) && referencePrice > 0 && Number.isFinite(triggerNumber)
      ? effectiveProtectionType === "short"
        ? ((triggerNumber - referencePrice) / referencePrice) * 100
        : ((referencePrice - triggerNumber) / referencePrice) * 100
      : NaN;
  const indicativeOptionMark = Number(protection?.premium ?? quote?.quote?.premium ?? 0);
  const protectedNotionalForEstimation = Number(protection?.protectedNotional ?? protectedValue);
  const maxTriggerProtectionValue =
    Number.isFinite(protectedNotionalForEstimation) && Number.isFinite(displayedDrawdownPct)
      ? protectedNotionalForEstimation * displayedDrawdownPct
      : NaN;
  const renewalChip = protection?.expiryAt
    ? `Renewal window: ${new Date(
        Date.parse(protection.expiryAt) - (protection.renewWindowMinutes || 0) * 60 * 1000
      ).toLocaleString()}`
    : null;
  const triggerLabel = effectiveProtectionType === "short" ? "Protection Ceiling Price" : "Protection Floor Price";
  const drawdownLabel =
    effectiveProtectionType === "short" ? "Max Upside Move Protected" : "Max Drawdown Protected";
  const positionDirectionLabel =
    effectiveProtectionType === "short" ? "Short Exposure (Call Hedge)" : "Long Exposure (Put Hedge)";
  const quoteProtectionType: ProtectionType = quote?.protectionType ?? protectionType;
  const quoteDirectionLabel =
    quoteProtectionType === "short" ? "Short Exposure (Call Hedge)" : "Long Exposure (Put Hedge)";
  const internalAdminEnabled =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("internal_admin") === "1";
  const showPriceFeedHint = internalAdminEnabled && isPriceUnavailableError(error);
  const liveReferencePrice = Number(monitor?.referencePrice ?? referencePrice);
  const liveTriggerPrice = monitor?.triggerPrice ?? displayedTriggerPrice;
  const liveDistanceToTriggerPct = Number(monitor?.distanceToTriggerPct ?? distanceToTriggerPct);
  const liveOptionMarkUsd = Number(monitor?.optionMarkUsd ?? indicativeOptionMark);
  const liveEstimatedTriggerValue = Number(monitor?.estimatedTriggerValue ?? maxTriggerProtectionValue);
  const adminSelected = adminRows.find((row) => row.protection_id === adminSelectedId) || null;
  const adminClientPremiumTotal = Number(adminMetrics?.clientPremiumTotalUsdc ?? 0);
  const adminHedgePremiumTotal =
    Number(adminMetrics?.hedgePremiumTotalUsdc ?? adminRows.reduce((sum, row) => sum + Number(row.premium || 0), 0));
  const adminBookedMargin = Number(adminMetrics?.bookedMarginUsdc ?? adminClientPremiumTotal - adminHedgePremiumTotal);
  const adminBookedMarginPct = Number(adminMetrics?.bookedMarginPct ?? 0);
  const adminPremiumDueTotal = Number(adminMetrics?.premiumDueTotalUsdc ?? 0);
  const adminPremiumSettledTotal = Number(adminMetrics?.premiumSettledTotalUsdc ?? 0);
  const adminPendingPremiumReceivable = Number(adminMetrics?.pendingPremiumReceivableUsdc ?? 0);
  const adminTotalPayoutDue =
    Number(adminMetrics?.payoutDueTotalUsdc ?? adminRows.reduce((sum, row) => sum + Number(row.payout_due_amount || 0), 0));
  const adminTotalPayoutSettled =
    Number(
      adminMetrics?.payoutSettledTotalUsdc ?? adminRows.reduce((sum, row) => sum + Number(row.payout_settled_amount || 0), 0)
    );
  const adminOpenPayoutLiability = Number(adminMetrics?.openPayoutLiabilityUsdc ?? adminTotalPayoutDue - adminTotalPayoutSettled);
  const adminStartingReserve = Number(adminMetrics?.startingReserveUsdc ?? 0);
  const adminAvailableReserve = Number(adminMetrics?.availableReserveUsdc ?? 0);
  const adminReserveAfterOpenLiability = Number(adminMetrics?.reserveAfterOpenPayoutLiabilityUsdc ?? 0);
  const adminNetSettledCash = Number(adminMetrics?.netSettledCashUsdc ?? adminPremiumSettledTotal - adminTotalPayoutSettled);
  const adminActiveCount = Number(adminMetrics?.activeProtections ?? adminRows.filter((row) => row.status === "active").length);
  const adminPageStart = adminPagination.total > 0 ? adminPagination.offset + 1 : 0;
  const adminPageEnd = Math.min(adminPagination.offset + adminRows.length, adminPagination.total);
  const adminCanPrevPage = adminPagination.offset > 0;
  const adminCanNextPage = adminPagination.nextOffset !== null;
  const adminTimeLeftMs = adminSelected ? Date.parse(adminSelected.expiry_at) - Date.now() : NaN;
  const adminSelectedClientPremium = Number(adminDetailProtection?.premium ?? adminSelected?.premium ?? 0);
  const adminSelectedHedgeCost = Number(
    (adminDetailProtection?.metadata?.hedgePremiumUsd as string | undefined) ||
      (adminDetailProtection?.metadata?.rawHedgePremiumUsd as string | undefined) ||
      0
  );
  const adminSelectedTradeMargin = adminSelectedClientPremium - adminSelectedHedgeCost;
  const adminSelectedTradeMarginPct =
    adminSelectedClientPremium > 0 ? (adminSelectedTradeMargin / adminSelectedClientPremium) * 100 : NaN;
  const adminSelectedPremiumDue = adminLedger
    .filter((entry) => entry.entryType === "premium_due")
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const adminSelectedPremiumSettled = adminLedger
    .filter((entry) => entry.entryType === "premium_settled")
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const adminSelectedPayoutDue = adminLedger
    .filter((entry) => entry.entryType === "payout_due")
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const adminSelectedPayoutSettled = adminLedger
    .filter((entry) => entry.entryType === "payout_settled")
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  const adminSelectedPremiumSettledRef = (() => {
    const settled = adminLedger.filter((entry) => entry.entryType === "premium_settled");
    return settled.length ? settled[settled.length - 1]?.reference || null : null;
  })();
  const adminSelectedPayoutSettledRef = (() => {
    const settled = adminLedger.filter((entry) => entry.entryType === "payout_settled");
    return settled.length ? settled[settled.length - 1]?.reference || null : null;
  })();
  const hasActiveInHistory = Boolean(protection && protectionsHistory.some((item) => item.id === protection.id));
  const activeProtectionForView = protection && hasActiveInHistory ? protection : null;
  const historyWithoutActive = activeProtectionForView
    ? protectionsHistory.filter((item) => item.id !== protection.id)
    : protectionsHistory;
  const protectionsTotalCount = protectionsHistory.length;

  if (!pilotUnlocked) {
    return (
      <div className="shell">
        <div className="card pilot-card pilot-gate-card">
          <div className="pilot-co-brand" aria-label="Foxify and Atticus logos">
            <div className="pilot-co-brand-logo-slot">
              {foxifyLogoFailed ? (
                <span className="pilot-co-brand-fallback">Foxify</span>
              ) : (
                <img
                  src={FOXIFY_LOGO_URL}
                  alt="Foxify logo"
                  className="pilot-co-brand-logo pilot-co-brand-logo--foxify"
                  onError={() => setFoxifyLogoFailed(true)}
                />
              )}
            </div>
            <span className="pilot-co-brand-separator">&lt;&gt;</span>
            <div className="pilot-co-brand-logo-slot">
              {atticusLogoFailed ? (
                <span className="pilot-co-brand-fallback">Atticus</span>
              ) : (
                <img
                  src={ATTICUS_LOGO_URL}
                  alt="Atticus logo"
                  className="pilot-co-brand-logo pilot-co-brand-logo--atticus"
                  onError={() => setAtticusLogoFailed(true)}
                />
              )}
            </div>
          </div>
          <h2 className="pilot-gate-title">Foxify Protection Pilot</h2>
          <div className="recommendation pilot-gate-copy">
            {termsStatus === "checking" && <div className="muted">Checking prior acceptance...</div>}
            <label className="pilot-gate-checkline">
              <input
                type="checkbox"
                checked={termsChecked}
                disabled={termsStatus === "accepted" || termsStatus === "checking" || termsBusy}
                onChange={(e) => setTermsChecked(e.target.checked)}
              />
              <span>
                I have read and accept{" "}
                <button
                  className="pilot-inline-terms-link"
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setTermsModalOpen(true);
                  }}
                >
                  Terms & Conditions
                </button>{" "}
                ({PILOT_TERMS_VERSION_DISPLAY})
              </span>
            </label>
            <button className="cta pilot-gate-cta" type="button" disabled={!canContinuePastGate} onClick={acceptTermsAndContinue}>
              {termsBusy ? "Saving..." : "Continue"}
            </button>
            {termsError && <div className="disclaimer danger">{termsError}</div>}
          </div>
        </div>

        {termsModalOpen && (
          <div className="modal" onClick={() => setTermsModalOpen(false)}>
            <div className="modal-card pilot-terms-modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div className="modal-title">
                  <h3>Foxify Protection Pilot Terms & Conditions</h3>
                </div>
                <button className="icon-btn" type="button" onClick={() => setTermsModalOpen(false)}>
                  x
                </button>
              </div>
              <div className="subheader pilot-terms-version">({PILOT_TERMS_VERSION_DISPLAY})</div>
              <div className="modal-body pilot-terms-body">
                <p className="pilot-terms-intro">
                  By proceeding, you acknowledge and agree to the following pilot terms.
                </p>
                <ol className="pilot-terms-list">
                  <li>Internal pilot only for manual perpetual position protection, limited to Foxify executives.</li>
                  <li>These terms apply to all Foxify executives who execute protections during this pilot.</li>
                  <li>Maximum protection notional is 50,000 USDC per protection request.</li>
                  <li>
                    Daily protected notional limit is 50,000 USDC for pilot operations and resets at 00:00 UTC each calendar day.
                  </li>
                  <li>Each protection uses a fixed 7-day tenor. Auto-renew may be enabled and remains subject to these terms.</li>
                  <li>
                    The pilot campaign runs for a maximum of 30 days from the official UTC start date configured by
                    Atticus Operations.
                  </li>
                  <li>
                    Premiums owed by Foxify are payable Net 10 after the pilot closes, unless superseded by a signed
                    written amendment.
                  </li>
                  <li>
                    Option payout proceeds are remitted to Foxify T+3 business days after venue settlement is confirmed
                    and reconciled.
                  </li>
                  <li>
                    Pilot records, including quote/activation/monitor/expiry outcomes and terms acceptance, are
                    retained for audit and reconciliation.
                  </li>
                  <li>
                    Legal owner and final signatory for this pilot record: Michael William.
                  </li>
                  <li>
                    Support and escalation: {PILOT_SUPPORT_EMAIL} · Telegram {PILOT_SUPPORT_TELEGRAM}
                  </li>
                </ol>
              </div>
              <div className="modal-actions pilot-terms-actions">
                <button className="btn btn-secondary" type="button" onClick={() => setTermsModalOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="card pilot-card">
        <div className="title pilot-title">
          <div className="brand pilot-header-brand-simple">
            {foxifyLogoFailed ? (
              <span className="pilot-co-brand-fallback">Foxify</span>
            ) : (
              <img
                src={FOXIFY_LOGO_URL}
                alt="Foxify logo"
                className="pilot-header-logo"
                onError={() => setFoxifyLogoFailed(true)}
              />
            )}
            <span>Protection Pilot</span>
          </div>
          {internalAdminEnabled && (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setShowAdminModal(true)}
            >
              Internal Admin
            </button>
          )}
        </div>

        <div className="section">
          <h4>Protection Request</h4>
          <div className={`pilot-reference-strip ${liveReferenceStale ? "pilot-reference-strip-stale" : ""}`}>
            <div className="pilot-reference-head">
              <span className="pilot-reference-title">BTC Reference Price</span>
              <button
                className="btn btn-secondary pilot-reference-refresh"
                type="button"
                disabled={liveReferenceBusy}
                onClick={() => {
                  setLiveReferenceBusy(true);
                  void (async () => {
                    try {
                      const res = await fetch(`${API_BASE}/pilot/reference-price?marketId=BTC-USD`);
                      const payload = (await res.json()) as ReferencePricePayload;
                      if (!res.ok || payload.status !== "ok" || !payload.reference) {
                        throw new Error(payload.reason || payload.message || "price_unavailable");
                      }
                      setLiveReference(payload.reference);
                      setLiveReferenceError(null);
                    } catch (error: any) {
                      setLiveReferenceError(friendlyError(String(error?.message || "price_unavailable")));
                    } finally {
                      setLiveReferenceBusy(false);
                    }
                  })();
                }}
              >
                {liveReferenceBusy ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <div className="pilot-reference-value">
              {Number.isFinite(liveReferenceNumber) ? `$${formatUsd(liveReferenceNumber)}` : "—"}
            </div>
            <div className="pilot-reference-meta muted">
              {liveReference
                ? `Venue ${liveReference.venue || "Reference Feed"} · Last update ${new Date(
                    liveReference.timestamp
                  ).toLocaleString()}${liveReferenceStale ? " · delayed" : ""}`
                : liveReferenceBusy
                  ? "Loading latest reference..."
                  : "Reference price unavailable"}
            </div>
            {liveReferenceError && <div className="disclaimer danger">{liveReferenceError}</div>}
          </div>
          <div className="recommendation pilot-form">
            <div className="pilot-form-row">
              <span className="pilot-label">Tier</span>
              <div className="pilot-field">
                <select
                  className="input pilot-input pilot-select"
                  value={tierName}
                  onChange={(e) => setTierName(e.target.value)}
                  disabled={busy || quoteLocked}
                >
                  {tiers.map((tier) => (
                    <option key={tier.name} value={tier.name}>
                      {tier.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Position Direction</span>
              <div className="pilot-field">
                <select
                  className="input pilot-input pilot-select"
                  value={protectionType}
                  onChange={(e) => setProtectionType(e.target.value as ProtectionType)}
                  disabled={busy || quoteLocked}
                >
                  <option value="long">Long (Put Hedge)</option>
                  <option value="short">Short (Call Hedge)</option>
                </select>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Position Size (USD)</span>
              <div className="pilot-field">
                <input
                  className="input pilot-input"
                  inputMode="decimal"
                  placeholder="e.g. 50,000"
                  value={exposureNotional}
                  disabled={busy || quoteLocked}
                  onChange={(e) => setExposureNotional(formatCurrencyInput(e.target.value))}
                />
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Protection Amount (USD)</span>
              <div className="pilot-field">
                <input
                  className="input pilot-input"
                  inputMode="decimal"
                  placeholder="e.g. 25,000"
                  value={protectedNotional}
                  disabled={busy || quoteLocked}
                  onChange={(e) => setProtectedNotional(formatCurrencyInput(e.target.value))}
                />
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Entry Price (Optional)</span>
              <div className="pilot-field pilot-field-entry">
                <input
                  className="input pilot-input pilot-input-text pilot-input-entry"
                  inputMode="decimal"
                  placeholder="e.g. $100,000"
                  value={entryPrice}
                  disabled={busy || quoteLocked}
                  onChange={(e) => setEntryPrice(formatCurrencyInput(e.target.value))}
                />
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">{drawdownLabel}</span>
              <div className="pilot-field pilot-value">
                <strong>{formatPct(selectedTier.drawdownFloorPct)}</strong>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">{triggerLabel}</span>
              <div className="pilot-field pilot-value">
                <strong>{displayedTriggerPrice ? `$${formatUsd(displayedTriggerPrice)}` : "Set from live quote"}</strong>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Tenor</span>
              <div className="pilot-field pilot-value">
                <strong>{selectedTier.expiryDays} days (fixed)</strong>
              </div>
            </div>

            <div className="pilot-form-row">
              <span className="pilot-label">Auto Renew</span>
              <div className="pilot-field">
                <label className="pilot-checkbox">
                  <input
                    type="checkbox"
                    checked={autoRenew}
                    disabled={busy || quoteLocked}
                    onChange={(e) => setAutoRenew(e.target.checked)}
                  />
                  <span>{autoRenew ? "Enabled" : "Disabled"}</span>
                </label>
              </div>
            </div>

            {!canQuote && (
              <div className="disclaimer danger">
                Enter position size and protection amount. Protection amount cannot exceed position size.
              </div>
            )}
          </div>
        </div>

        <div className="section">
          <div className="section-title-row">
            <h4>Quote</h4>
            {quoteState === "fetching" && <span className="pill">Fetching optimal price</span>}
            {quoteState === "ready" && quoteTimeLeft > 0 && (
              <span className="pill pill-warning">Expires in {formatCountdown(quoteTimeLeft)}</span>
            )}
            {quoteState === "expired" && <span className="pill pill-warning">Quote expired</span>}
          </div>
          <div className={`quote-card quote-card-${quoteState}`}>
            {quoteState === "idle" && (
              <div className="muted">Request Quote to fetch a live premium and lock window.</div>
            )}
            {quoteState === "fetching" && (
              <div className="muted">
                <span className="spinner" />
                Fetching optimal protection quote...
              </div>
            )}
            {(quoteState === "ready" || quoteState === "expired") && quote && (
              <>
                <div className="muted">
                  Premium <strong>${formatUsd(quote.quote.premium)}</strong> · Venue{" "}
                  <strong>{formatVenueLabel(quote.quote.venue)}</strong>
                </div>
                <div className="muted">
                  {quoteDirectionLabel} · Tier {quote.tierName}
                </div>
                <div className="muted">
                  Move threshold {formatPct(quote.drawdownFloorPct)} ·{" "}
                  {quote.triggerLabel === "ceiling_price" ? "Ceiling" : "Floor"} $
                  {formatUsd(quote.triggerPrice ?? quote.floorPrice)}
                </div>
                <div className="muted">
                  Reference {formatUsd(quote.entrySnapshot.price)} ({quote.entrySnapshot.source}) at{" "}
                  {new Date(quote.entrySnapshot.timestamp).toLocaleString()}
                </div>
              </>
            )}
          </div>
          {quoteLocked && (
            <div className="muted">Quote locked: core request fields are temporarily read-only until refresh or expiry.</div>
          )}
          {quoteCapWarning && (
            <div className="disclaimer danger">
              Daily protection limit reached for pilot operations. Quote is shown for reference; confirmation is blocked
              until the next UTC day.
            </div>
          )}
        </div>

        <div className="section">
          <div className="pilot-actions">
            <button className="btn btn-secondary pilot-action-btn" disabled={busy || !canQuote} onClick={requestQuote}>
              {quoteState === "fetching" ? "Fetching..." : "Request Quote"}
            </button>
            <button className="cta pilot-action-btn" disabled={busy || !canActivate} onClick={activateProtection}>
              {busy && quoteState !== "fetching" ? "Confirming..." : "Confirm Protection"}
            </button>
          </div>
          {error && <div className="disclaimer danger">{error}</div>}
          {showPriceFeedHint && (
            <div className="disclaimer">
              Quick check: API must run with PILOT_API_ENABLED=true, PRICE_SINGLE_SOURCE=true, and a valid
              PRICE_REFERENCE_URL (Coinbase ticker).{" "}
              <button
                className="btn btn-secondary pilot-retry-btn"
                type="button"
                disabled={busy || !canQuote}
                onClick={requestQuote}
              >
                Retry quote
              </button>
            </div>
          )}
        </div>

        <div className="section">
          <div className="section-title-row">
            <h4>
              Protections <span className="muted">({protectionsTotalCount})</span>
            </h4>
            {historyBusy && <span className="pill">Loading…</span>}
            <div className="section-actions">
              <button
                className="btn btn-secondary pilot-inline-btn"
                disabled={busy || historyBusy}
                onClick={() => void refreshProtectionHistory()}
              >
                {historyBusy ? "Refreshing..." : "Refresh"}
              </button>
              <button
                className="btn btn-secondary pilot-inline-btn collapse-toggle"
                type="button"
                onClick={() => setShowHistorySection((prev) => !prev)}
                aria-expanded={showHistorySection}
              >
                <span className={`collapse-chevron ${showHistorySection ? "open" : ""}`} aria-hidden="true">
                  {">"}
                </span>
                {showHistorySection ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          {!showHistorySection && protectionsTotalCount > 0 && pilotUnlocked && (
            <div className="muted section-collapsed-note">Protections hidden.</div>
          )}
          <div className={`collapsible-panel ${showHistorySection && pilotUnlocked ? "is-open" : "is-closed"}`}>
            <div className="collapsible-inner">
              {historyBusy ? (
                <div className="muted section-collapsed-note">
                  <span className="spinner" />
                  Loading protections...
                </div>
              ) : !activeProtectionForView && historyWithoutActive.length === 0 ? (
                <div className="muted">No protections found yet.</div>
              ) : (
                <div className="positions">
                  {activeProtectionForView && (
                    <div className="position-row position-row-active">
                      <div className="position-main">
                        <div className="position-main-title">
                          <strong>{positionDirectionLabel}</strong>
                          <span className="pill">active</span>
                          <span className="pill pill-warning">Current</span>
                        </div>
                        <div className="muted">ID {activeProtectionForView.id}</div>
                        <div className="muted">
                          {triggerLabel.replace("Protection ", "")}{" "}
                          {displayedTriggerPrice ? `$${formatUsd(displayedTriggerPrice)}` : "—"} · Premium{" "}
                          {activeProtectionForView.premium ? `$${formatUsd(activeProtectionForView.premium)}` : "—"} · Expires{" "}
                          {new Date(activeProtectionForView.expiryAt).toLocaleString()}
                        </div>
                        {renewalChip && <div className="muted">{renewalChip}</div>}
                      </div>
                      <div className="position-actions">
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => {
                            setMonitor(null);
                            setShowProtectionModal(true);
                            void refreshMonitor(activeProtectionForView.id);
                          }}
                        >
                          Open Monitor
                        </button>
                      </div>
                    </div>
                  )}

                  {historyWithoutActive.length > 0 && (
                    <div className="muted section-subtitle">Recent Protections</div>
                  )}
                  {historyWithoutActive.map((item) => {
                    const itemType =
                      item.metadata && String(item.metadata.protectionType || "").toLowerCase() === "short"
                        ? "short"
                        : "long";
                    const itemDirection =
                      itemType === "short" ? "Short Exposure (Call Hedge)" : "Long Exposure (Put Hedge)";
                    const itemTriggerLabel =
                      itemType === "short" ? "Ceiling Price" : "Floor Price";
                    return (
                      <div className="position-row" key={item.id}>
                        <div className="position-main">
                          <div className="position-main-title">
                            <strong>{itemDirection}</strong>
                            <span className="pill">{item.status}</span>
                          </div>
                          <div className="muted">
                            ID {item.id}
                          </div>
                          <div className="muted">
                            {itemTriggerLabel} {item.floorPrice ? `$${formatUsd(item.floorPrice)}` : "—"} · Premium{" "}
                            {item.premium ? `$${formatUsd(item.premium)}` : "—"} · Expires{" "}
                            {new Date(item.expiryAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="position-actions">
                          <button
                            className="btn"
                            disabled={busy}
                            onClick={() => {
                              setProtection(item);
                              setMonitor(null);
                              setShowProtectionModal(true);
                              void refreshMonitor(item.id);
                            }}
                          >
                            Open Monitor
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showProtectionModal && protection && (
        <div className="modal" onClick={() => setShowProtectionModal(false)}>
          <div className="modal-card pilot-monitor" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h3>Protection Monitor</h3>
              </div>
              <button className="icon-btn" type="button" onClick={() => setShowProtectionModal(false)}>
                x
              </button>
            </div>
            <div className="muted pilot-monitor-subtitle">
              Protected position {protection.id} · Auto-refresh every 10s
              {lastUpdatedAt ? ` · Updated ${lastUpdatedAt.toLocaleTimeString()}` : ""}
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                disabled={monitorBusy}
                onClick={() => void refreshMonitor(protection.id)}
              >
                {monitorBusy ? "Refreshing..." : "Refresh Monitor"}
              </button>
            </div>
            <div className="pilot-monitor-grid">
              <div className="pilot-monitor-card">
                <div className="label">Reference BTC Price</div>
                <div className="value">${formatUsd(liveReferencePrice)}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Protection Anchor Price</div>
                <div className="value">${formatUsd(protection.entryPrice)}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">{triggerLabel}</div>
                <div className="value">{liveTriggerPrice ? `$${formatUsd(liveTriggerPrice)}` : "—"}</div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Distance to Trigger</div>
                <div className={`value ${liveDistanceToTriggerPct < 3 ? "danger" : ""}`}>
                  {Number.isFinite(liveDistanceToTriggerPct) ? `${liveDistanceToTriggerPct.toFixed(2)}%` : "—"}
                </div>
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Option Mark (Indicative)</div>
                <div className="value">${formatUsd(liveOptionMarkUsd)}</div>
                {monitor?.markSource && <div className="muted">{monitor.markSource}</div>}
              </div>
              <div className="pilot-monitor-card">
                <div className="label">Est. Protection Value at Trigger</div>
                <div className="value">
                  {Number.isFinite(liveEstimatedTriggerValue) ? `$${formatUsd(liveEstimatedTriggerValue)}` : "—"}
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowProtectionModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdminModal && internalAdminEnabled && (
        <div className="modal" onClick={() => setShowAdminModal(false)}>
          <div className="modal-card modal-wide pilot-admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h3>Atticus Internal Admin</h3>
              </div>
              <button className="icon-btn" type="button" onClick={() => setShowAdminModal(false)}>
                x
              </button>
            </div>

            {!adminToken && (
              <div className="modal-body">
                <div className="muted">Internal-only access. Enter Atticus admin token to unlock data.</div>
                <div className="pilot-form-row">
                  <span className="pilot-label">Admin Token</span>
                  <div className="pilot-field">
                    <input
                      className="input pilot-input pilot-input-text"
                      type="password"
                      value={adminTokenInput}
                      onChange={(e) => setAdminTokenInput(e.target.value)}
                      placeholder="x-admin-token"
                    />
                  </div>
                </div>
                <div className="modal-actions">
                  <button
                    className="cta"
                    disabled={!adminTokenInput.trim() || adminBusy}
                    onClick={() => void loadAdminRows(adminTokenInput.trim())}
                  >
                    {adminBusy ? "Unlocking..." : "Unlock Admin"}
                  </button>
                </div>
              </div>
            )}

            {adminToken && (
              <div className="modal-body">
                <div className="pilot-admin-grid">
                  <div className="pilot-monitor-card">
                    <div className="label">Active Protections</div>
                    <div className="value">{adminActiveCount}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Starting Reserve</div>
                    <div className="value">${formatUsd(adminStartingReserve)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Available Reserve</div>
                    <div className="value">${formatUsd(adminAvailableReserve)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Reserve After Open Liability</div>
                    <div className="value">${formatUsd(adminReserveAfterOpenLiability)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Hedge Premium (Venue Cost)</div>
                    <div className="value">${formatUsd(adminHedgePremiumTotal)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Client Premium (Charged)</div>
                    <div className="value">${formatUsd(adminClientPremiumTotal)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Platform Margin (Booked)</div>
                    <div className="value">${formatUsd(adminBookedMargin)}</div>
                    <div className="muted">{Number.isFinite(adminBookedMarginPct) ? `${adminBookedMarginPct.toFixed(2)}%` : "—"}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Premium Due (Atticus Receivable)</div>
                    <div className="value">${formatUsd(adminPremiumDueTotal)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Premium Settled (Received)</div>
                    <div className="value">${formatUsd(adminPremiumSettledTotal)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Pending Premium Receivable</div>
                    <div className="value">${formatUsd(adminPendingPremiumReceivable)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Payout Liability</div>
                    <div className="value">${formatUsd(adminTotalPayoutDue)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Payout Settled</div>
                    <div className="value">${formatUsd(adminTotalPayoutSettled)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Open Payout Liability</div>
                    <div className="value">${formatUsd(adminOpenPayoutLiability)}</div>
                  </div>
                  <div className="pilot-monitor-card">
                    <div className="label">Net Settled Cash (Premium - Payout Settled)</div>
                    <div className="value">${formatUsd(adminNetSettledCash)}</div>
                  </div>
                </div>
                <div className="muted">
                  Hedge cost and client premium are shown separately for margin visibility. Settled metrics move only when
                  settlement events are posted.
                </div>

                <div className="modal-actions">
                  <button
                    className="btn"
                    disabled={adminBusy}
                    onClick={() => void loadAdminRows(adminToken, adminPagination.offset)}
                  >
                    {adminBusy ? "Refreshing..." : "Refresh Admin Data"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={adminBusy || adminDownloadingReconciliation}
                    onClick={() => void downloadReconciliationCsv(adminToken)}
                  >
                    {adminDownloadingReconciliation ? "Preparing CSV..." : "Download Reconciliation CSV"}
                  </button>
                </div>

                <div className="muted">
                  Showing {adminPageStart}-{adminPageEnd} of {adminPagination.total} scoped protections.
                </div>

                <div className="modal-actions">
                  <button
                    className="btn btn-secondary"
                    disabled={adminBusy || !adminCanPrevPage}
                    onClick={() =>
                      void loadAdminRows(
                        adminToken,
                        Math.max(0, adminPagination.offset - Math.max(adminPagination.limit, 1))
                      )
                    }
                  >
                    Previous Page
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={adminBusy || !adminCanNextPage}
                    onClick={() => {
                      if (adminPagination.nextOffset !== null) {
                        void loadAdminRows(adminToken, adminPagination.nextOffset);
                      }
                    }}
                  >
                    Next Page
                  </button>
                </div>

                <div className="pilot-admin-table">
                  <div className="pilot-admin-head">
                    <span>Protection ID</span>
                    <span>Status</span>
                    <span>Premium</span>
                    <span>Expiry</span>
                    <span>Venue</span>
                    <span>Action</span>
                  </div>
                  {adminRows.map((row) => (
                    <div
                      className={`pilot-admin-row ${adminSelectedId === row.protection_id ? "pilot-admin-row-selected" : ""}`}
                      key={row.protection_id}
                    >
                      <span>{row.protection_id}</span>
                      <span>{row.status}</span>
                      <span>{row.premium ? `$${formatUsd(row.premium)}` : "—"}</span>
                      <span>{new Date(row.expiry_at).toLocaleString()}</span>
                      <span>{row.venue || "—"}</span>
                      <span>
                        <button
                          className="btn btn-secondary"
                          disabled={adminViewingId === row.protection_id}
                          onClick={() => {
                            setAdminSelectedId(row.protection_id);
                            setShowAdminDetailModal(true);
                            if (adminToken) {
                              void refreshAdminSelection(row.protection_id, adminToken);
                            }
                          }}
                        >
                          {adminViewingId === row.protection_id ? "Loading..." : "View details"}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>

              </div>
            )}

            {adminError && <div className="disclaimer danger">{adminError}</div>}
          </div>
        </div>
      )}

      {showAdminDetailModal && adminSelected && (
        <div className="modal" onClick={() => setShowAdminDetailModal(false)}>
          <div className="modal-card pilot-admin-detail" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h3>Protection Detail</h3>
              </div>
              <button className="icon-btn" type="button" onClick={() => setShowAdminDetailModal(false)}>
                x
              </button>
            </div>
            <div className="muted">ID: {adminSelected.protection_id}</div>
            {adminDetailUpdatedAt && <div className="muted">Updated {adminDetailUpdatedAt.toLocaleTimeString()}</div>}
            <div className="muted">
              Status: {adminSelected.status} · Time Left:{" "}
              {Number.isFinite(adminTimeLeftMs) && adminTimeLeftMs > 0
                ? formatCountdown(Math.floor(adminTimeLeftMs / 1000))
                : "expired"}
            </div>
            <div className="muted">
              {adminSelected.entry_price ? `Entry $${formatUsd(adminSelected.entry_price)}` : "Entry —"} ·{" "}
              {adminSelected.floor_price ? `Trigger $${formatUsd(adminSelected.floor_price)}` : "Trigger —"} ·{" "}
              {adminSelected.instrument_id || "No instrument"}
            </div>
            <div className="muted">
              MTM Option Mark:{" "}
              {adminMonitor && Number.isFinite(Number(adminMonitor.optionMarkUsd))
                ? `$${formatUsd(adminMonitor.optionMarkUsd)}`
                : "—"}
              {adminMonitor?.markSource ? ` (${adminMonitor.markSource})` : ""}
            </div>
            <div className="muted">
              Hedge Cost (Venue):{" "}
              {Number.isFinite(adminSelectedHedgeCost) && adminSelectedHedgeCost > 0
                ? `$${formatUsd(adminSelectedHedgeCost)}`
                : "—"}
            </div>
            <div className="muted">
              Client Premium:{" "}
              {Number.isFinite(adminSelectedClientPremium) && adminSelectedClientPremium > 0
                ? `$${formatUsd(adminSelectedClientPremium)}`
                : "—"}
            </div>
            <div className="muted">
              Trade Margin:{" "}
              {Number.isFinite(adminSelectedTradeMargin)
                ? `$${formatUsd(adminSelectedTradeMargin)}${Number.isFinite(adminSelectedTradeMarginPct) ? ` (${adminSelectedTradeMarginPct.toFixed(2)}%)` : ""}`
                : "—"}
            </div>
            <div className="muted">
              Premium Due/Settled/Outstanding: ${formatUsd(adminSelectedPremiumDue)} / $
              {formatUsd(adminSelectedPremiumSettled)} / $
              {formatUsd(adminSelectedPremiumDue - adminSelectedPremiumSettled)}
            </div>
            <div className="muted">
              Payout Due/Settled/Outstanding: ${formatUsd(adminSelectedPayoutDue)} / $
              {formatUsd(adminSelectedPayoutSettled)} / $
              {formatUsd(adminSelectedPayoutDue - adminSelectedPayoutSettled)}
            </div>
            <div className="muted">
              Premium Settlement Ref: {adminSelectedPremiumSettledRef || "—"} · Payout Settlement Ref:{" "}
              {adminSelectedPayoutSettledRef || "—"}
            </div>
            <div className="muted">
              Venue IDs: Order {adminSelected.external_order_id || "—"} · Execution {adminSelected.external_execution_id || "—"}
            </div>
            <div className="muted">
              Quote IDs: Quote {(adminDetailProtection?.metadata?.quoteId as string | undefined) || "—"} · RFQ{" "}
              {(adminDetailProtection?.metadata?.rfqId as string | undefined) || "—"}
            </div>
            <div className="muted">Payout Tx Ref: {adminDetailProtection?.payoutTxRef || "—"}</div>
            <div className="muted">
              Reference:{" "}
              {adminMonitor && Number.isFinite(Number(adminMonitor.referencePrice))
                ? `$${formatUsd(adminMonitor.referencePrice)}`
                : "—"}
            </div>
            <div className="pilot-admin-ledger">
              <strong>Ledger Entries</strong>
              {adminLedger.length === 0 ? (
                <div className="muted">No ledger entries found.</div>
              ) : (
                adminLedger.map((entry) => (
                  <div className="muted" key={entry.id}>
                    {entry.entryType} · {entry.amount} {entry.currency} · {new Date(entry.createdAt).toLocaleString()}
                  </div>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowAdminDetailModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenewModal && (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-header">
              <div className="modal-title">
                <h3>Renewal Required</h3>
              </div>
            </div>
            <div className="modal-body">
              <p>
                The renewal window has started and auto-renew is off. Choose how to proceed.
              </p>
              <div className="modal-actions">
                <button className="btn" disabled={busy} onClick={() => submitRenewDecision("expire")}>
                  Let protection expire
                </button>
                <button className="cta" disabled={busy} onClick={() => submitRenewDecision("renew")}>
                  Renew protection
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

