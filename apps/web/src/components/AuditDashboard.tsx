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

export function AuditDashboard() {
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [coverageFilter, setCoverageFilter] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [showNetExposure, setShowNetExposure] = useState(false);

  const load = useCallback(async () => {
    const [summaryRes, entriesRes] = await Promise.all([
      fetch(`${API_BASE}/audit/summary?mode=internal`),
      fetch(`${API_BASE}/audit/entries?limit=200`)
    ]);
    const summaryData = await summaryRes.json();
    const entriesData = await entriesRes.json();
    setSummary(summaryData);
    setEntries(Array.isArray(entriesData) ? entriesData : []);
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
  const subsidy = summary.subsidy;
  const profitability = summary.profitability;
  const allowedEvents = new Set([
    "coverage_activated",
    "hedge_order",
    "hedge_action",
    "coverage_renewed",
    "mtm_credit",
    "liquidity_update"
  ]);
  const hasMtmCredit = (entry: AuditEntry) => {
    const positionPnl = Number((entry.payload as any)?.positionPnlUsdc ?? 0);
    const hedgeMtm = Number((entry.payload as any)?.hedgeMtmUsdc ?? 0);
    if (!Number.isFinite(positionPnl) && !Number.isFinite(hedgeMtm)) return false;
    return positionPnl !== 0 || hedgeMtm !== 0;
  };
  const visibleEntries = entries.filter((entry) => {
    if (!allowedEvents.has(entry.event)) return false;
    if (entry.event === "mtm_credit") return hasMtmCredit(entry);
    return true;
  });
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
      const premium = extractField(entry, "premiumUsdc");
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
    <div className="section">
      <h4>Audit Dashboard (Internal)</h4>
      <div className="stats stats-buffer">
        <div className="stat">
          <div className="label">Coverage Activated</div>
          <div className="value">{summary.totals.coverage_activated || 0}</div>
          <div className="inline">
            <span>Last</span>
            <span>{summary.lastCoverage ? "Yes" : "—"}</span>
          </div>
        </div>
        <div className="stat">
          <div className="label">Hedge Actions</div>
          <div className="value">{summary.totals.hedge_action || 0}</div>
          <div className="inline">
            <span>Last</span>
            <span>{summary.lastHedgeAction ? "Yes" : "—"}</span>
          </div>
        </div>
      </div>

      <div className="section">
        <h4>Liquidity Panel</h4>
        <div className="recommendation">
          <div className="row row-align">
            <span>Liquidity</span>
            <strong>${liquidity ? liquidity.liquidityBalanceUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Hedge Spend</span>
            <strong>${liquidity ? liquidity.hedgeSpendUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Hedge Margin</span>
            <strong>${liquidity ? liquidity.hedgeMarginUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Revenue</span>
            <strong>${liquidity ? liquidity.revenueUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Profit</span>
            <strong>${liquidity ? liquidity.profitUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Reinvest</span>
            <strong>${liquidity ? liquidity.reinvestUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Reserve</span>
            <strong>${liquidity ? liquidity.reserveUsdc.toFixed(2) : "—"}</strong>
          </div>
        </div>
      </div>
      <div className="section">
        <h4>Subsidy Budget</h4>
        <div className="recommendation">
          <div className="row row-align">
            <span>Total Today</span>
            <strong>${subsidy ? subsidy.totalUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Date</span>
            <strong>{subsidy?.dateKey ?? "—"}</strong>
          </div>
        </div>
      </div>

      <div className="section">
        <h4>Profitability</h4>
        <div className="recommendation">
          <div className="row row-align">
            <span>Gross Revenue</span>
            <strong>${profitability?.grossRevenueUsdc !== undefined ? profitability.grossRevenueUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Hedge Spend</span>
            <strong>${profitability?.grossHedgeSpendUsdc !== undefined ? profitability.grossHedgeSpendUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Subsidy</span>
            <strong>${profitability?.grossSubsidyUsdc !== undefined ? profitability.grossSubsidyUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Gross Profit</span>
            <strong>${profitability?.grossProfitUsdc !== undefined ? profitability.grossProfitUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Gross Margin</span>
            <strong>
              {profitability?.grossMarginPct !== undefined && profitability?.grossMarginPct !== null
                ? `${profitability.grossMarginPct.toFixed(2)}%`
                : "—"}
            </strong>
          </div>
          <div className="row row-align">
            <span>Booked Profit</span>
            <strong>
              {profitability?.bookedProfitUsdc !== undefined
                ? profitability.bookedProfitUsdc.toFixed(2)
                : "—"}
            </strong>
          </div>
          <div className="row row-align">
            <span>Expected Profit</span>
            <strong>
              {profitability?.expectedProfitUsdc !== undefined
                ? profitability.expectedProfitUsdc.toFixed(2)
                : "—"}
            </strong>
          </div>
          <div className="row row-align">
            <span>Cash Profit</span>
            <strong>${profitability ? profitability.cashProfitUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Hedge MTM</span>
            <strong>${profitability ? profitability.hedgeMtmUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Realized Hedge PnL</span>
            <strong>${profitability ? profitability.realizedHedgePnlUsdc.toFixed(2) : "—"}</strong>
          </div>
          <div className="row row-align">
            <span>Unrealized Hedge PnL</span>
            <strong>
              {profitability?.unrealizedHedgePnlUsdc !== undefined
                ? profitability.unrealizedHedgePnlUsdc.toFixed(2)
                : "—"}
            </strong>
          </div>
          <div className="row row-align">
            <span>Hedge Notional</span>
            <strong>
              {profitability?.hedgeNotionalUsdc !== undefined
                ? `$${profitability.hedgeNotionalUsdc.toFixed(2)}`
                : "—"}
            </strong>
          </div>
          <div className="row row-align">
            <span>Hedge Margin %</span>
            <strong>
              {profitability?.hedgeMarginPct !== undefined && profitability?.hedgeMarginPct !== null
                ? `${profitability.hedgeMarginPct.toFixed(2)}%`
                : "—"}
            </strong>
          </div>
          <div className="row row-align">
            <span>Net Profit</span>
            <strong>${profitability ? profitability.netProfitUsdc.toFixed(2) : "—"}</strong>
          </div>
        </div>
      </div>

      <div className="section">
        <h4>Hedge Cost Breakdown</h4>
        <div className="recommendation">
          <div className="row row-align">
            <span>Per-User Hedge Cost</span>
            <strong>${perUserHedgeCost.toFixed(2)}</strong>
          </div>
          <div className="row row-align">
            <span>Pool Hedge Cost</span>
            <strong>${poolHedgeCost.toFixed(2)}</strong>
          </div>
          <div className="row row-align">
            <span>Fee Collected</span>
            <strong>${feeCollected.toFixed(2)}</strong>
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
              <span>Premium</span>
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
            const premium = extractField(entry, "premiumUsdc");
            const hedgeSize = extractField(entry, "hedgeSize") ?? extractField(entry, "amount");
            const hedgeType = extractField(entry, "hedgeType") || extractField(entry, "optionType");
            const notional = extractField(entry, "notionalUsdc");
            const hedgeSpend =
              extractField(entry, "hedgeMarginUsdc") ??
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
    </div>
  );
}
