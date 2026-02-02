import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "../config";

type AuditSummary = {
  totals: Record<string, number>;
  lastCoverage: Record<string, unknown> | null;
  lastRenewal: Record<string, unknown> | null;
  lastHedgeAction: Record<string, unknown> | null;
  lastMtmCredit: Record<string, unknown> | null;
  risk?: Record<string, unknown>;
  liquidity?: {
    liquidityBalanceUsdc: number;
    hedgeSpendUsdc: number;
    hedgeMarginUsdc: number;
    revenueUsdc: number;
    profitUsdc: number;
    reinvestUsdc: number;
    reserveUsdc: number;
  };
  subsidy?: {
    dateKey: string;
    totalUsdc: number;
    byTier: Record<string, number>;
    byAccount: Record<string, number>;
  };
  profitability?: {
    grossRevenueUsdc?: number;
    grossHedgeSpendUsdc?: number;
    grossSubsidyUsdc?: number;
    grossProfitUsdc?: number;
    grossMarginPct?: number | null;
    cashProfitUsdc: number;
    hedgeMtmUsdc: number;
    realizedHedgePnlUsdc: number;
    unrealizedHedgePnlUsdc?: number;
    hedgeNotionalUsdc?: number;
    hedgeMarginPct?: number | null;
    bookedProfitUsdc?: number;
    expectedProfitUsdc?: number;
    netProfitUsdc: number;
  };
};

type AuditEntry = {
  ts: string;
  event: string;
  payload?: Record<string, unknown>;
};

export function AuditDashboard({
  initialSummary,
  initialEntries
}: {
  initialSummary?: Record<string, unknown> | null;
  initialEntries?: Array<Record<string, unknown>>;
}) {
  const [summary, setSummary] = useState<AuditSummary | null>(
    (initialSummary as AuditSummary) ?? null
  );
  const [entries, setEntries] = useState<AuditEntry[]>(
    (initialEntries as AuditEntry[]) ?? []
  );
  const [coverageFilter, setCoverageFilter] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [showNetExposure, setShowNetExposure] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);

  const load = useCallback(async () => {
    const [summaryRes, entriesRes] = await Promise.all([
      fetch(`${API_BASE}/audit/summary?mode=internal`),
      fetch(`${API_BASE}/audit/logs?limit=200`)
    ]);
    const summaryData = await summaryRes.json();
    const entriesData = await entriesRes.json();
    setSummary(summaryData);
    setEntries(Array.isArray(entriesData?.entries) ? entriesData.entries : []);
    if (entriesData?.count !== undefined) {
      console.log(
        `✓ Loaded ${entriesData.count} CEO-relevant events (${entriesData.totalEvents || 0} total)`
      );
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const resetAllData = useCallback(async () => {
    if (resetBusy) return;
    const ok = window.confirm("Clear all historical data? This cannot be undone.");
    if (!ok) return;
    setResetBusy(true);
    try {
      const res = await fetch(`${API_BASE}/admin/reset`, { method: "POST" });
      if (!res.ok) throw new Error("reset_failed");
      localStorage.removeItem("foxify_portfolio");
      localStorage.removeItem("foxify_protect_last");
      window.location.reload();
    } catch {
      setResetBusy(false);
    }
  }, [resetBusy]);

  if (!summary) return <div className="empty">Loading audit summary...</div>;

  const liquidity = summary.liquidity;
  const profitability = summary.profitability;
  const stats = {
    coverageCount: summary.totals?.coverage_activated || 0,
    hedgeCount: summary.totals?.hedge_action || 0,
    liquidity: liquidity?.liquidityBalanceUsdc ?? 0,
    revenue: liquidity?.revenueUsdc ?? 0,
    hedgeSpend: liquidity?.hedgeSpendUsdc ?? 0,
    unrealizedPnl: profitability?.unrealizedHedgePnlUsdc ?? 0
  };
  // ═══════════════════════════════════════════════════════════
  // CEO AUDIT EVENTS FILTER
  // Must match CEO_AUDIT_EVENTS in services/api/src/server.ts
  // Last synced: 2026-01-31
  // Count: 13 events
  // ═══════════════════════════════════════════════════════════
  const allowedEvents = new Set([
    "coverage_activated",
    "coverage_renewed",
    "coverage_expired",
    "coverage_duplicate",
    "liquidity_update",
    "hedge_order",
    "hedge_action",
    "put_quote_failed",
    "put_renew_failed",
    "option_exec_failed",
    "close_blocked",
    "put_renew"
  ]);
  console.log(`✓ Frontend audit filter: ${allowedEvents.size} event types`);
  const visibleEntries = entries.filter((entry) => allowedEvents.has(entry.event));
  const isNetExposure = (entry: AuditEntry) => {
    const coverageId = String(entry.payload?.coverageId || "");
    if (coverageId.startsWith("net-") || coverageId === "platform-risk") return true;
    const coverageIds = (entry.payload as any)?.coverageIds as string[] | undefined;
    if (
      Array.isArray(coverageIds) &&
      coverageIds.some((id) => id.startsWith("net-") || id === "platform-risk")
    ) {
      return true;
    }
    return false;
  };
  const scopedEntries = showNetExposure
    ? visibleEntries
    : visibleEntries.filter((entry) => !isNetExposure(entry));
  const filteredEntries = coverageFilter
    ? scopedEntries.filter((entry) => String(entry.payload?.coverageId || "") === coverageFilter)
    : scopedEntries;
  const orderedEntries = filteredEntries
    .slice()
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const MAX_AUDIT_ROWS = 120;
  const limitedEntries = orderedEntries.slice(0, MAX_AUDIT_ROWS);
  const coverageOptions = Array.from(
    new Set(
      scopedEntries
        .map((entry) => String(entry.payload?.coverageId || ""))
        .filter((value) => value && value !== "—")
    )
  );

  const formatAbbrev = (value: number) => {
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
    return value.toFixed(2);
  };

  const formatSmall = (value: number) => {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) < 1) return value.toFixed(4);
    if (Math.abs(value) < 100) return value.toFixed(2);
    return value.toFixed(0);
  };

  const extractField = (entry: AuditEntry, key: string) => {
    const payload = entry.payload || {};
    if (key in payload) return (payload as any)[key];
    const hedge = (payload as any).hedge;
    if (hedge && key in hedge) return hedge[key];
    const quote = (payload as any).quote;
    if (quote && key in quote) return quote[key];
    return null;
  };
  const parseInstrument = (instrument: string) => {
    const parts = instrument.split("-");
    if (parts.length >= 4) {
      return {
        asset: parts[0],
        expiryTag: parts[1],
        strike: Number(parts[2]),
        optionType: parts[3]?.toLowerCase() === "p" ? "put" : "call"
      };
    }
    if (instrument.includes("PERPETUAL")) {
      return { asset: instrument.split("-")[0], expiryTag: "PERP", strike: null, optionType: "perp" };
    }
    return { asset: "", expiryTag: "", strike: null, optionType: "" };
  };
  const hedgeOrders = scopedEntries.filter((entry) => entry.event === "hedge_order");
  const coverageEntries = scopedEntries.filter((entry) => entry.event === "coverage_activated");
  const sumPremium = (list: AuditEntry[]) =>
    list.reduce((sum, entry) => {
      const premium =
        extractField(entry, "executedPremiumUsdc") ?? extractField(entry, "premiumUsdc");
      return sum + (premium !== null && premium !== undefined ? Number(premium) : 0);
    }, 0);
  const perUserHedgeCost = sumPremium(hedgeOrders.filter((entry) => !isNetExposure(entry)));
  const poolHedgeCost = sumPremium(hedgeOrders.filter((entry) => isNetExposure(entry)));
  const feeCollected = coverageEntries.reduce((sum, entry) => {
    const payload = entry.payload || {};
    const totalFee = (payload as any).totalFeeUsd ?? (payload as any).feeUsd ?? 0;
    return sum + Number(totalFee || 0);
  }, 0);

  return (
    <div>
      <div className="section">
        <div className="audit-header">
          <div className="audit-header-bar">
            <div>
              <h2 className="audit-header-title">Platform Health Dashboard</h2>
              <p className="audit-header-subtitle">Real-time protection and hedge monitoring</p>
            </div>
            <div className="audit-header-actions">
              <button className="audit-glossary-btn" onClick={() => setShowGlossary(true)}>
                <svg className="audit-glossary-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                  />
                </svg>
                <span>Glossary</span>
              </button>
              <div className="audit-status">
                <span className="audit-status-dot" />
                <span className="audit-status-text">Operational</span>
              </div>
            </div>
          </div>

          <div className="audit-metrics">
            <div className="audit-metric">
              <span className="audit-metric-label">Active Coverage</span>
              <span className="audit-metric-value">{stats.coverageCount || 0}</span>
              <span className="audit-metric-sub">protections active</span>
            </div>

            <div className="audit-metric">
              <span className="audit-metric-label">Hedge Actions</span>
              <span className="audit-metric-value">{stats.hedgeCount || 0}</span>
              <span className="audit-metric-sub">executed (24h)</span>
            </div>

            <div className="audit-metric">
              <span className="audit-metric-label">Available Reserves</span>
              <span className="audit-metric-value audit-metric-value-blue">
                ${(stats.liquidity || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
              <span className="audit-metric-sub">capital available</span>
            </div>

            <div className="audit-metrics-divider" />

            <div className="audit-metric">
              <span className="audit-metric-label">Premium Collected</span>
              <span className="audit-metric-value audit-metric-value-positive">
                ${(stats.revenue || 0).toFixed(2)}
              </span>
              <span className="audit-metric-sub">premiums charged</span>
            </div>

            <div className="audit-metric">
              <span className="audit-metric-label">Hedging Spend</span>
              <span className="audit-metric-value audit-metric-value-warn">
                ${(stats.hedgeSpend || 0).toFixed(2)}
              </span>
              <span className="audit-metric-sub">premiums paid</span>
            </div>

            <div className="audit-metric">
              <span className="audit-metric-label">Protocol Margin</span>
              <span
                className={`audit-metric-value ${
                  stats.revenue - stats.hedgeSpend >= 0
                    ? "audit-metric-value-positive"
                    : "audit-metric-value-warn"
                }`}
              >
                ${(stats.revenue - stats.hedgeSpend).toFixed(2)}
              </span>
              <span className="audit-metric-sub">
                {(stats.revenue - stats.hedgeSpend) >= 0 ? "operating profit" : "coverage cost"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title-row section-gap">
          <h4>Audit Entries</h4>
          <div className="header-actions">
            <select
              className="input audit-filter"
              value={coverageFilter ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setCoverageFilter(value ? value : null);
              }}
            >
              <option value="">All coverages</option>
              {coverageOptions.map((coverageId) => (
                <option key={coverageId} value={coverageId}>
                  {coverageId}
                </option>
              ))}
            </select>
            <button
              className={autoRefresh ? "btn active" : "btn"}
              onClick={() => {
                const next = !autoRefresh;
                setAutoRefresh(next);
                if (next) load();
              }}
            >
              {autoRefresh ? "Auto Refresh: On" : "Auto Refresh: Off"}
            </button>
            <button className="btn danger" onClick={resetAllData} disabled={resetBusy}>
              {resetBusy ? "Clearing..." : "Clear History"}
            </button>
            <button
              className={showNetExposure ? "btn active" : "btn"}
              onClick={() => setShowNetExposure((prev) => !prev)}
            >
              {showNetExposure ? "Net Exposure: On" : "Net Exposure: Off"}
            </button>
            <span className="muted">Showing latest {MAX_AUDIT_ROWS}</span>
          </div>
        </div>
        <div className="audit-table-wrap">
          <div className="audit-table">
            <div className="audit-row audit-head">
              <span>Time</span>
              <span>Event</span>
              <span>Protection ID</span>
              <span>Instrument</span>
              <span>Expiry</span>
              <span>Strike</span>
              <span>Side</span>
              <span>Status</span>
              <span>Premium In</span>
              <span>Premium Out</span>
              <span>Hedge Size</span>
              <span>Hedge Type</span>
              <span>Notional</span>
              <span>Hedge Spend</span>
              <span>Projected Payout</span>
              <span>Liquidity Δ</span>
            </div>
            {limitedEntries.length === 0 && (
              <div className="empty">No audit entries yet.</div>
            )}
            {limitedEntries.map((entry) => {
            const coverageId = String(entry.payload?.coverageId || "");
            const instrument = String(extractField(entry, "instrument") || "—");
            const parsedInstrument = instrument !== "—" ? parseInstrument(instrument) : null;
            const expiryTag = String(extractField(entry, "expiryTag") || parsedInstrument?.expiryTag || "—");
            const strikeValue = extractField(entry, "strike") ?? parsedInstrument?.strike ?? null;
            const side = String(extractField(entry, "side") || "—");
            const status = String(extractField(entry, "status") || "—");
            const premium =
              extractField(entry, "executedPremiumUsdc") ?? extractField(entry, "premiumUsdc");
            const feeIn =
              extractField(entry, "totalFeeUsd") ??
              extractField(entry, "feeUsd") ??
              extractField(entry, "feeUsdc");
            const hedgeSize = extractField(entry, "hedgeSize") ?? extractField(entry, "amount");
            const hedgeType = extractField(entry, "hedgeType") || extractField(entry, "optionType");
            const notional = extractField(entry, "notionalUsdc");
            const hedgeSpend =
              extractField(entry, "hedgeMarginUsdc") ??
              extractField(entry, "executedPremiumUsdc") ??
              extractField(entry, "premiumUsdc") ??
              extractField(entry, "hedgeNotionalUsdc");
            const floorPrice = extractField(entry, "floorPrice");
            const optionType =
              String(extractField(entry, "optionType") || parsedInstrument?.optionType || "")
                .toLowerCase();
            const strikeNum = strikeValue !== null && strikeValue !== undefined ? Number(strikeValue) : null;
            const floorNum =
              floorPrice !== null && floorPrice !== undefined ? Number(floorPrice) : null;
            const hedgeSizeNum =
              hedgeSize !== null && hedgeSize !== undefined ? Number(hedgeSize) : null;
            const projectedPayout =
              optionType &&
              (optionType === "put" || optionType === "call") &&
              strikeNum !== null &&
              floorNum !== null &&
              hedgeSizeNum !== null
                ? Math.max(optionType === "put" ? strikeNum - floorNum : floorNum - strikeNum, 0) *
                  hedgeSizeNum
                : null;
            const delta = extractField(entry, "delta") as any;
            const deltaValue =
              delta && typeof delta === "object"
                ? delta.liquidityBalanceUsdc ?? delta.revenueUsdc
                : null;
            return (
              <div className="audit-row" key={`${entry.ts}-${entry.event}`}>
                <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                <span>{entry.event}</span>
                <span>{coverageId || "—"}</span>
                <span>{instrument}</span>
                <span>{expiryTag || "—"}</span>
                <span>
                  {strikeNum !== null && Number.isFinite(strikeNum) ? strikeNum.toFixed(0) : "—"}
                </span>
                <span>{side || "—"}</span>
                <span>{status || "—"}</span>
                <span title={feeIn !== null && feeIn !== undefined ? `$${feeIn}` : "—"}>
                  {feeIn !== null && feeIn !== undefined ? `$${formatSmall(Number(feeIn))}` : "—"}
                </span>
                <span title={premium !== null && premium !== undefined ? `$${premium}` : "—"}>
                  {premium !== null && premium !== undefined ? `$${formatSmall(Number(premium))}` : "—"}
                </span>
                <span title={hedgeSize !== null && hedgeSize !== undefined ? String(hedgeSize) : "—"}>
                  {hedgeSize !== null && hedgeSize !== undefined
                    ? formatSmall(Number(hedgeSize))
                    : "—"}
                </span>
                <span>{hedgeType || "—"}</span>
                <span title={notional !== null && notional !== undefined ? `$${notional}` : "—"}>
                  {notional !== null && notional !== undefined
                    ? `$${formatAbbrev(Number(notional))}`
                    : "—"}
                </span>
                <span title={hedgeSpend !== null && hedgeSpend !== undefined ? `$${hedgeSpend}` : "—"}>
                  {hedgeSpend !== null && hedgeSpend !== undefined
                    ? `$${formatAbbrev(Number(hedgeSpend))}`
                    : "—"}
                </span>
                <span title={projectedPayout !== null ? `$${projectedPayout}` : "—"}>
                  {projectedPayout !== null ? `$${formatSmall(projectedPayout)}` : "—"}
                </span>
                <span title={deltaValue !== null && deltaValue !== undefined ? String(deltaValue) : "—"}>
                  {deltaValue !== null && deltaValue !== undefined
                    ? formatAbbrev(Number(deltaValue))
                    : "—"}
                </span>
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {showGlossary && (
        <>
          <div
            className="glossary-backdrop animate-fadeIn"
            onClick={() => setShowGlossary(false)}
          />
          <div className="glossary-panel animate-slideIn">
            <div className="glossary-header">
              <div className="glossary-header-title">
                <svg className="glossary-header-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                  />
                </svg>
                <h3>Platform Glossary</h3>
              </div>
              <button className="glossary-close" onClick={() => setShowGlossary(false)}>
                <svg className="glossary-close-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <p className="glossary-subtitle">
                Quick reference for dashboard metrics and terminology
              </p>
            </div>

            <div className="glossary-content">
              <div className="glossary-section">
                <div className="glossary-section-title">
                  <span className="glossary-section-accent glossary-accent-blue" />
                  <h4>Dashboard Metrics</h4>
                </div>
                <div className="glossary-cards">
                  <div className="glossary-card">
                    <dt>
                      <span className="glossary-dot glossary-dot-blue" />
                      Active Coverage
                    </dt>
                    <dd>
                      Number of protection policies currently active. Each policy covers a specific
                      cryptocurrency amount against price drops below the strike price.
                    </dd>
                  </div>
                  <div className="glossary-card">
                    <dt>
                      <span className="glossary-dot glossary-dot-blue" />
                      Hedge Actions (24h)
                    </dt>
                    <dd>
                      Number of offsetting trades executed in the last 24 hours to reduce platform risk
                      exposure. Hedges protect the platform from large payouts.
                    </dd>
                  </div>
                  <div className="glossary-card">
                    <dt>
                      <span className="glossary-dot glossary-dot-blue" />
                      Available Reserves
                    </dt>
                    <dd>
                      Total capital in the liquidity pool available to pay claims and execute hedges.
                      Must maintain minimum 1.5× ratio to total obligations.
                    </dd>
                  </div>
                  <div className="glossary-card">
                    <dt className="glossary-title-green">
                      <span className="glossary-dot glossary-dot-green" />
                      Revenue Collected
                    </dt>
                    <dd>
                      Total premiums paid by users to purchase protections. Primary revenue source.
                      Higher coverage volume generates higher revenue.
                    </dd>
                  </div>
                  <div className="glossary-card">
                    <dt className="glossary-title-orange">
                      <span className="glossary-dot glossary-dot-orange" />
                      Hedging Spend
                    </dt>
                    <dd>
                      Cost of premiums paid to DEXs and option protocols to hedge risk. This is
                      operational cost for protection, not a loss.
                    </dd>
                  </div>
                  <div className="glossary-card">
                    <dt className="glossary-title-green">
                      <span className="glossary-dot glossary-dot-green" />
                      Protocol Margin
                    </dt>
                    <dd>
                      Revenue minus hedge costs. Positive = profitable operations. Negative = investing
                      in coverage (hedges pay out later when protections are claimed).
                    </dd>
                  </div>
                </div>
              </div>

              <div className="glossary-divider" />

              <div className="glossary-section">
                <div className="glossary-section-title">
                  <span className="glossary-section-accent glossary-accent-purple" />
                  <h4>Key Terms</h4>
                </div>
                <div className="glossary-terms">
                  <div className="glossary-term">
                    <dt>Protection Policy</dt>
                    <dd>
                      Financial instrument that pays out if crypto price drops below strike. Similar to
                      insurance but not regulated as insurance.
                    </dd>
                  </div>
                  <div className="glossary-term">
                    <dt>Strike Price</dt>
                    <dd>Price level at which protection activates and becomes eligible for payout.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>Premium</dt>
                    <dd>
                      Premium paid by user to purchase protection. Calculated based on amount, duration,
                      volatility, and market conditions.
                    </dd>
                  </div>
                  <div className="glossary-term">
                    <dt>Hedge</dt>
                    <dd>
                      Offsetting position (options or perpetual futures) taken to reduce directional
                      risk exposure.
                    </dd>
                  </div>
                  <div className="glossary-term">
                    <dt>Delta</dt>
                    <dd>
                      Sensitivity of protection value to price changes. Tells us how much to hedge.
                      Ranges from -1 to 0 for put-like protections.
                    </dd>
                  </div>
                  <div className="glossary-term">
                    <dt>Liquidity Ratio</dt>
                    <dd>
                      Available reserves divided by maximum potential obligations. Target minimum 1.5×.
                    </dd>
                  </div>
                  <div className="glossary-term">
                    <dt>DEX</dt>
                    <dd>
                      Decentralized exchange used for executing hedge trades (e.g., Uniswap, GMX).
                    </dd>
                  </div>
                  <div className="glossary-term">
                    <dt>Net Exposure</dt>
                    <dd>
                      Audit filter showing net risk exposure calculations (excludes individual hedge
                      transactions).
                    </dd>
                  </div>
                </div>
              </div>

              <div className="glossary-divider" />

              <div className="glossary-section">
                <div className="glossary-section-title">
                  <span className="glossary-section-accent glossary-accent-yellow" />
                  <h4>Status Colors</h4>
                </div>
                <div className="glossary-statuses">
                  <div className="glossary-status">
                    <span className="glossary-status-dot glossary-dot-green" />
                    <div>
                      <dt className="glossary-title-green">Green</dt>
                      <dd>Optimal. System healthy, metrics within targets.</dd>
                    </div>
                  </div>
                  <div className="glossary-status">
                    <span className="glossary-status-dot glossary-dot-yellow" />
                    <div>
                      <dt className="glossary-title-yellow">Yellow</dt>
                      <dd>Caution. Approaching limits, monitor closely.</dd>
                    </div>
                  </div>
                  <div className="glossary-status">
                    <span className="glossary-status-dot glossary-dot-orange" />
                    <div>
                      <dt className="glossary-title-orange">Orange</dt>
                      <dd>Warning. Below target but operational, action may be needed.</dd>
                    </div>
                  </div>
                  <div className="glossary-status">
                    <span className="glossary-status-dot glossary-dot-red" />
                    <div>
                      <dt className="glossary-title-red">Red</dt>
                      <dd>Critical. Immediate attention required, may halt operations.</dd>
                    </div>
                  </div>
                </div>
              </div>

              <div className="glossary-divider" />

              <div className="glossary-section">
                <div className="glossary-section-title">
                  <span className="glossary-section-accent glossary-accent-blue" />
                  <h4>Audit Event Categories</h4>
                </div>
                <div className="glossary-terms">
                  <div className="glossary-term">
                    <dt>coverage_activated</dt>
                    <dd>
                      Protection policy created. Payload includes tier, portfolio positions, notional,
                      floor, and expiry.
                    </dd>
                  </div>
                  <div className="glossary-term">
                    <dt>coverage_renewed</dt>
                    <dd>Auto-renew executed. Includes new expiry and hedge instrument.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>coverage_expired</dt>
                    <dd>Coverage reached expiry and is no longer active.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>coverage_duplicate</dt>
                    <dd>Duplicate activation detected for an existing live coverageId.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>hedge_action</dt>
                    <dd>Decision to increase/decrease/hold a hedge; includes reason and size.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>hedge_order</dt>
                    <dd>Order placed for a hedge action; includes instrument, side, size, and status.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>liquidity_update</dt>
                    <dd>
                      Liquidity accounting update after premiums/hedges. Includes deltas and totals.
                    </dd>
                  </div>
                  <div className="glossary-term">
                    <dt>mtm_credit</dt>
                    <dd>Equity update that includes hedge MTM contribution.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>put_quote_failed</dt>
                    <dd>Protective put quote failed due to pricing or liquidity constraints.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>put_renew_failed</dt>
                    <dd>Auto-renew attempt failed.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>option_exec_failed</dt>
                    <dd>Hedge option execution failed (insufficient liquidity or venue issue).</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>close_blocked</dt>
                    <dd>Close request blocked due to drawdown buffer guard.</dd>
                  </div>
                  <div className="glossary-term">
                    <dt>put_renew</dt>
                    <dd>Auto-renew result payload (pricing, instrument, status).</dd>
                  </div>
                </div>
              </div>

              <div className="glossary-spacer" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
