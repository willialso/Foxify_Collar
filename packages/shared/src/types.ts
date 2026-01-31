export type AccountType = "challenge" | "flash";

export interface FundedAccount {
  accountId: string;
  accountType: AccountType;
  balanceUsdc: string;
  collateralUsdc?: string;
  fundingUsdc?: string;
  timeRemainingSeconds: number;
  pointsAccrued?: string;
  level: string;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  size: string;
  entryPrice: string;
  markPrice: string;
  leverage: string;
  unrealizedPnlUsdc: string;
}

export interface HedgeLeg {
  instrument: string;
  side: "buy" | "sell";
  size: string;
  price: string;
  type: "option" | "perp";
}

export interface CollarQuote {
  putStrike: string;
  callStrike: string;
  expiry: string;
  netPremiumUsdc: string;
  legs: HedgeLeg[];
}
