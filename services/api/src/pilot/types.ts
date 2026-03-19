export type ProtectionStatus =
  | "pending_activation"
  | "activation_failed"
  | "active"
  | "awaiting_renew_decision"
  | "awaiting_expiry_price"
  | "expired_itm"
  | "expired_otm"
  | "cancelled";

export type LedgerEntryType = "premium_due" | "premium_settled" | "payout_due" | "payout_settled";

export type PriceSnapshotType = "entry" | "expiry";

export type PriceSource = "reference_oracle" | "fallback_oracle";

export type VenueExecutionStatus = "success" | "failure";

export type ProtectionType = "long" | "short";

export type PriceSnapshotRecord = {
  id: string;
  protectionId: string;
  snapshotType: PriceSnapshotType;
  price: string;
  marketId: string;
  priceSource: PriceSource;
  priceSourceDetail: string;
  endpointVersion: string;
  requestId: string;
  priceTimestamp: string;
  createdAt: string;
};

export type ProtectionRecord = {
  id: string;
  userHash: string;
  hashVersion: number;
  status: ProtectionStatus;
  tierName: string | null;
  drawdownFloorPct: string | null;
  floorPrice: string | null;
  marketId: string;
  protectedNotional: string;
  entryPrice: string | null;
  entryPriceSource: string | null;
  entryPriceTimestamp: string | null;
  expiryAt: string;
  expiryPrice: string | null;
  expiryPriceSource: string | null;
  expiryPriceTimestamp: string | null;
  autoRenew: boolean;
  renewWindowMinutes: number;
  venue: string | null;
  instrumentId: string | null;
  side: string | null;
  size: string | null;
  executionPrice: string | null;
  premium: string | null;
  executedAt: string | null;
  externalOrderId: string | null;
  externalExecutionId: string | null;
  payoutDueAmount: string | null;
  payoutSettledAmount: string | null;
  payoutSettledAt: string | null;
  payoutTxRef: string | null;
  foxifyExposureNotional: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type VenueQuote = {
  venue: "falconx" | "deribit_test" | "mock_falconx";
  quoteId: string;
  rfqId?: string | null;
  instrumentId: string;
  side: "buy";
  quantity: number;
  premium: number;
  expiresAt: string;
  quoteTs: string;
  details?: Record<string, unknown>;
};

export type VenueExecution = {
  venue: "falconx" | "deribit_test" | "mock_falconx";
  status: VenueExecutionStatus;
  quoteId: string;
  rfqId?: string | null;
  instrumentId: string;
  side: "buy";
  quantity: number;
  executionPrice: number;
  premium: number;
  executedAt: string;
  externalOrderId: string;
  externalExecutionId: string;
  details?: Record<string, unknown>;
};

