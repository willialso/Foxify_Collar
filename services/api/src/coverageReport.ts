export type PortfolioExposure = {
  asset: string;
  side: "long" | "short";
  entryPrice: number;
  size: number;
  leverage: number;
};

export type CoveragePosition = {
  id: string;
  asset: string;
  side: "long" | "short";
  marginUsd: number;
  leverage: number;
  entryPrice: number;
};

export type CoverageLedgerEntryLite = {
  coverageId: string;
  accountId?: string | null;
  positions?: CoveragePosition[];
  hedgeInstrument?: string | null;
  hedgeSize?: number | null;
  optionType?: "put" | "call" | null;
  strike?: number | null;
  pricingReason?: string | null;
  quotedFeeUsdc?: number | null;
  hedgeSpendUsdc?: number | null;
  floorUsd?: number | null;
  equityUsd?: number | null;
  coverageLegs?: Array<{
    instrument: string;
    size: number;
  }>;
};

export type CoverageReportRow = {
  positionId: string;
  asset: string;
  side: "long" | "short";
  entryPrice: number;
  size: number;
  leverage: number;
  coverageId: string | null;
  hedgeInstrument: string | null;
  expiryTag: string | null;
  optionType: string | null;
  strike: number | null;
  reason: string | null;
  feeUsd: number | null;
  premiumUsd: number | null;
  subsidyUsd: number;
  requiredSize: number;
  coveredSize: number;
  coveragePct: string;
  floorStrike: number;
  isCovered: boolean;
};

function normalizeAccountId(value: string | null | undefined): string {
  const id = String(value || "").trim();
  return id.length ? id : "demo";
}

function derivePositionSize(position: CoveragePosition): number {
  const notional = Number(position.marginUsd || 0) * Number(position.leverage || 1);
  return position.entryPrice ? notional / Number(position.entryPrice) : 0;
}

function deriveLedgerHedgeSize(entry: CoverageLedgerEntryLite): number {
  if (Array.isArray(entry.coverageLegs) && entry.coverageLegs.length > 0) {
    return entry.coverageLegs.reduce((sum, leg) => sum + Number(leg.size || 0), 0);
  }
  return Number(entry.hedgeSize ?? 0);
}

function deriveDrawdownFloorPct(entry: CoverageLedgerEntryLite, fallback = 0.2): number {
  const equity = Number(entry.equityUsd ?? 0);
  const floor = Number(entry.floorUsd ?? 0);
  if (equity > 0 && floor > 0) {
    return Math.max(0, 1 - floor / equity);
  }
  return fallback;
}

function parseExpiryTag(instrument?: string | null): string | null {
  if (!instrument) return null;
  const parts = String(instrument).split("-");
  return parts.length >= 2 ? parts[1] || null : null;
}

function calculateCoverageStatus(
  position: PortfolioExposure,
  coveredSize: number,
  drawdownFloorPct = 0.2
): {
  requiredSize: number;
  coveredSize: number;
  coveragePct: number;
  floorStrike: number;
  isCovered: boolean;
} {
  const requiredSize = position.size || 0;
  const coveragePct =
    requiredSize > 0 ? Math.min(1, coveredSize / requiredSize) * 100 : 0;
  const floorStrike =
    position.side === "long"
      ? position.entryPrice * (1 - drawdownFloorPct)
      : position.entryPrice * (1 + drawdownFloorPct);
  const isCovered = coveredSize >= requiredSize * 0.99;
  return { requiredSize, coveredSize, coveragePct, floorStrike, isCovered };
}

type Candidate = { entry: CoverageLedgerEntryLite; diff: number };

function findCoverageMatch(
  position: PortfolioExposure,
  entries: CoverageLedgerEntryLite[]
): CoverageLedgerEntryLite | null {
  const exactMatches: CoverageLedgerEntryLite[] = [];
  const candidates: Candidate[] = [];

  for (const entry of entries) {
    const ledgerPositions = Array.isArray(entry.positions) ? entry.positions : [];
    for (const ledgerPos of ledgerPositions) {
      if (ledgerPos.asset !== position.asset || ledgerPos.side !== position.side) continue;
      const sameLeverage = Number(ledgerPos.leverage || 0) === Number(position.leverage || 0);
      const sameEntry = Number(ledgerPos.entryPrice || 0) === Number(position.entryPrice || 0);
      if (sameLeverage && sameEntry) {
        exactMatches.push(entry);
        continue;
      }
      const size = derivePositionSize(ledgerPos);
      const diff = Math.abs(size - Number(position.size || 0));
      candidates.push({ entry, diff });
    }
  }

  if (exactMatches.length > 0) {
    return exactMatches[exactMatches.length - 1];
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.diff - b.diff);
  return candidates[0].entry;
}

export function buildCoverageReport(params: {
  accountId?: string;
  positions: PortfolioExposure[];
  coverageLedgerEntries: CoverageLedgerEntryLite[];
}): {
  results: CoverageReportRow[];
  covered: number;
  coveragePct: string;
} {
  const accountId = normalizeAccountId(params.accountId);
  const allEntries = Array.isArray(params.coverageLedgerEntries) ? params.coverageLedgerEntries : [];
  const accountEntries = allEntries.filter((entry) => {
    const raw = String(entry.accountId ?? "").trim();
    if (!raw.length) return true;
    return normalizeAccountId(entry.accountId) === accountId;
  });
  const searchEntries = accountEntries;

  const results: CoverageReportRow[] = params.positions.map((position, idx) => {
    const match = findCoverageMatch(position, searchEntries);
    const coveredSize = match ? deriveLedgerHedgeSize(match) : 0;
    const drawdownFloorPct = match ? deriveDrawdownFloorPct(match, 0.2) : 0.2;
    const status = calculateCoverageStatus(position, coveredSize, drawdownFloorPct);

    return {
      positionId: `pos_${idx + 1}`,
      asset: position.asset,
      side: position.side,
      entryPrice: position.entryPrice,
      size: position.size,
      leverage: position.leverage,
      coverageId: match?.coverageId ?? null,
      hedgeInstrument: match?.hedgeInstrument ?? null,
      expiryTag: parseExpiryTag(match?.hedgeInstrument ?? null),
      optionType: match?.optionType ?? null,
      strike: match?.strike ?? null,
      reason: match?.pricingReason ?? null,
      feeUsd:
        match?.quotedFeeUsdc !== undefined && match?.quotedFeeUsdc !== null
          ? Number(match.quotedFeeUsdc)
          : null,
      premiumUsd:
        match?.hedgeSpendUsdc !== undefined && match?.hedgeSpendUsdc !== null
          ? Number(match.hedgeSpendUsdc)
          : null,
      subsidyUsd: 0,
      requiredSize: status.requiredSize,
      coveredSize: status.coveredSize,
      coveragePct: status.coveragePct.toFixed(2),
      floorStrike: status.floorStrike,
      isCovered: status.isCovered
    };
  });

  const covered = results.filter((row) => row.isCovered).length;
  const coveragePct = results.length ? ((covered / results.length) * 100).toFixed(2) : "0";
  return { results, covered, coveragePct };
}
