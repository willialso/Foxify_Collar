import { readFile } from "node:fs/promises";
import Decimal from "decimal.js";

export interface RiskControlsConfig {
  risk_budget_pct_min: number;
  risk_budget_pct_max: number;
  volatility_throttle_iv: number;
  hedge_reduction_factor: number;
  max_leverage?: number;
  net_exposure_cap_usdc: Record<string, number>;
  initial_liquidity_usdc?: number;
  reinvest_pct?: number;
  reserve_pct?: number;
  max_spread_pct?: number;
  max_slippage_pct?: number;
  max_spread_pct_by_days?: Record<string, number>;
  max_slippage_pct_by_days?: Record<string, number>;
  liquidity_override_enabled?: boolean;
  liquidity_override_spread_pct?: number;
  liquidity_override_slippage_pct?: number;
  liquidity_override_spread_pct_by_days?: Record<string, number>;
  liquidity_override_slippage_pct_by_days?: Record<string, number>;
  min_option_size?: number;
  default_target_days?: number;
  max_target_days?: number;
  fallback_target_days?: number;
  option_score_weights?: {
    protection?: number;
    premium?: number;
    liquidity?: number;
    volatility?: number;
  };
  subsidy_daily_cap_usdc?: number;
  subsidy_tier_daily_cap_usdc?: Record<string, number>;
  subsidy_account_daily_cap_usdc?: number;
  subsidy_volatility_multiplier?: number;
  survival_tolerance_pct?: number;
  min_fee_usdc_by_tier?: Record<string, number>;
  premium_floor_ratio?: number;
  fee_iv_uplift_threshold?: number;
  fee_iv_uplift_pct_by_tier?: Record<string, number>;
  fee_iv_regime_thresholds?: {
    low: number;
    high: number;
  };
  fee_iv_regime_multipliers_by_tier?: Record<
    string,
    {
      low?: number;
      normal?: number;
      high?: number;
    }
  >;
  fee_leverage_multipliers_by_x?: Record<string, number>;
  pass_through_cap_by_leverage?: Record<string, number>;
  pass_through_cap_by_tier?: Record<string, Record<string, number>>;
  enable_premium_pass_through?: boolean;
  require_user_opt_in_for_pass_through?: boolean;
  pass_through_min_notification_ratio?: number;
  coverage_override_tiers?: string[];
  duration_fee_per_day_pct?: number;
  duration_fee_max_pct?: number;
  partial_coverage_discount_pct?: number;
  ctc_enabled?: boolean;
  ctc_buffer_pct?: number;
  ctc_margin_by_tier?: Record<string, number>;
  ctc_ops_buffer_usdc_by_tier?: Record<string, number>;
  ctc_floor_buckets?: number[];
  ctc_price_buffer_pct?: number;
  ctc_max_snapshot_age_ms?: number;
  option_search_budget_ms?: number;
}

export interface RiskState {
  dateKey: string;
  revenueUsdc: Decimal;
  overageUsdc: Decimal;
  notionalUsdc: Decimal;
}

export interface LiquidityState {
  liquidityBalanceUsdc: Decimal;
  hedgeSpendUsdc: Decimal;
  hedgeMarginUsdc: Decimal;
  revenueUsdc: Decimal;
  profitUsdc: Decimal;
  reinvestUsdc: Decimal;
  reserveUsdc: Decimal;
}

export interface SubsidyState {
  dateKey: string;
  totalUsdc: Decimal;
  byTier: Record<string, Decimal>;
  byAccount: Record<string, Decimal>;
}

const DEFAULTS: RiskControlsConfig = {
  risk_budget_pct_min: 0.25,
  risk_budget_pct_max: 0.4,
  volatility_throttle_iv: 0.8,
  hedge_reduction_factor: 0.7,
  max_leverage: 10,
  net_exposure_cap_usdc: {},
  initial_liquidity_usdc: 20000,
  reinvest_pct: 0.5,
  reserve_pct: 0.3,
  max_spread_pct: 0.05,
  max_slippage_pct: 0.01,
  max_spread_pct_by_days: {},
  max_slippage_pct_by_days: {},
  liquidity_override_enabled: false,
  liquidity_override_spread_pct: 0.2,
  liquidity_override_slippage_pct: 0.03,
  liquidity_override_spread_pct_by_days: {},
  liquidity_override_slippage_pct_by_days: {},
  min_option_size: 0.01,
  default_target_days: 7,
  max_target_days: 7,
  fallback_target_days: 14,
  option_score_weights: {
    protection: 0.4,
    premium: 0.25,
    liquidity: 0.25,
    volatility: 0.1
  },
  subsidy_daily_cap_usdc: 500,
  subsidy_tier_daily_cap_usdc: {},
  subsidy_account_daily_cap_usdc: 100,
  subsidy_volatility_multiplier: 0.5,
  survival_tolerance_pct: 0.98,
  min_fee_usdc_by_tier: {},
  premium_floor_ratio: 1.25,
  fee_iv_uplift_threshold: 0.8,
  fee_iv_uplift_pct_by_tier: {},
  fee_iv_regime_thresholds: {
    low: 0.5,
    high: 0.8
  },
  fee_iv_regime_multipliers_by_tier: {},
  fee_leverage_multipliers_by_x: {},
  pass_through_cap_by_leverage: {},
  pass_through_cap_by_tier: {},
  enable_premium_pass_through: true,
  require_user_opt_in_for_pass_through: false,
  pass_through_min_notification_ratio: 1.5,
  coverage_override_tiers: ["Pro (Gold)", "Pro (Platinum)"],
  duration_fee_per_day_pct: 0.04,
  duration_fee_max_pct: 0.6,
  partial_coverage_discount_pct: 0.15,
  ctc_enabled: false,
  ctc_buffer_pct: 0.15,
  ctc_margin_by_tier: {
    "Pro (Bronze)": 0.6,
    "Pro (Silver)": 0.5,
    "Pro (Gold)": 0.4,
    "Pro (Platinum)": 0.3
  },
  ctc_ops_buffer_usdc_by_tier: {
    "Pro (Bronze)": 1,
    "Pro (Silver)": 2,
    "Pro (Gold)": 3,
    "Pro (Platinum)": 4
  },
  ctc_floor_buckets: [0.12, 0.16, 0.2],
  ctc_price_buffer_pct: 0.02,
  ctc_max_snapshot_age_ms: 10000,
  option_search_budget_ms: 1200
};

let cachedConfig: RiskControlsConfig | null = null;
let cachedConfigMtime = 0;
let stateByTier: Record<string, RiskState> = {};
let liquidityState: LiquidityState = {
  liquidityBalanceUsdc: new Decimal(DEFAULTS.initial_liquidity_usdc ?? 0),
  hedgeSpendUsdc: new Decimal(0),
  hedgeMarginUsdc: new Decimal(0),
  revenueUsdc: new Decimal(0),
  profitUsdc: new Decimal(0),
  reinvestUsdc: new Decimal(0),
  reserveUsdc: new Decimal(0)
};
let subsidyDailyTotal = new Decimal(0);
let subsidyByTier: Record<string, Decimal> = {};
let subsidyByAccount: Record<string, Decimal> = {};
let subsidyDateKey = dayKey();

const toDecimal = (value: Decimal.Value | null | undefined) => new Decimal(value ?? 0);

function dayKey(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

export async function loadRiskControls(path: URL): Promise<RiskControlsConfig> {
  const stat = await (await import("node:fs/promises")).stat(path);
  if (cachedConfig && stat.mtimeMs === cachedConfigMtime) return cachedConfig;
  const raw = await readFile(path, "utf-8");
  cachedConfig = { ...DEFAULTS, ...JSON.parse(raw) };
  cachedConfigMtime = stat.mtimeMs;
  if (cachedConfig.initial_liquidity_usdc !== undefined) {
    liquidityState.liquidityBalanceUsdc = toDecimal(cachedConfig.initial_liquidity_usdc);
  }
  return cachedConfig;
}

function ensureSubsidyDay(): void {
  const key = dayKey();
  if (key !== subsidyDateKey) {
    subsidyDateKey = key;
    subsidyDailyTotal = 0;
    subsidyByTier = {};
    subsidyByAccount = {};
  }
}

export function canApplySubsidy(
  tier: string,
  accountId: string | null,
  amountUsdc: Decimal,
  iv?: number
): { allowed: boolean; reason: string } {
  ensureSubsidyDay();
  const config = cachedConfig ?? DEFAULTS;
  const baseDailyCap = toDecimal(
    config.subsidy_daily_cap_usdc ?? DEFAULTS.subsidy_daily_cap_usdc ?? 0
  );
  const tierCap = toDecimal(
    config.subsidy_tier_daily_cap_usdc?.[tier] ??
      DEFAULTS.subsidy_tier_daily_cap_usdc?.[tier] ??
      baseDailyCap
  );
  const accountCap = toDecimal(
    config.subsidy_account_daily_cap_usdc ?? DEFAULTS.subsidy_account_daily_cap_usdc ?? 0
  );
  const ivThreshold = config.volatility_throttle_iv ?? DEFAULTS.volatility_throttle_iv ?? 0.8;
  const multiplier = config.subsidy_volatility_multiplier ?? DEFAULTS.subsidy_volatility_multiplier ?? 1;
  const highVol = iv !== undefined && iv > ivThreshold;
  const multiplierDecimal = highVol ? toDecimal(multiplier) : new Decimal(1);
  const effectiveDailyCap = baseDailyCap.mul(multiplierDecimal);
  const effectiveTierCap = tierCap.mul(multiplierDecimal);
  const effectiveAccountCap = accountCap.mul(multiplierDecimal);

  const tierUsed = toDecimal(subsidyByTier[tier] ?? new Decimal(0));
  const accountKey = accountId || "unknown";
  const accountUsed = toDecimal(subsidyByAccount[accountKey] ?? new Decimal(0));
  const amount = toDecimal(amountUsdc);
  const dailyTotal = toDecimal(subsidyDailyTotal);

  if (dailyTotal.add(amount).gt(effectiveDailyCap)) {
    return { allowed: false, reason: "daily_cap" };
  }
  if (tierUsed.add(amount).gt(effectiveTierCap)) {
    return { allowed: false, reason: "tier_cap" };
  }
  if (effectiveAccountCap.gt(0) && accountUsed.add(amount).gt(effectiveAccountCap)) {
    return { allowed: false, reason: "account_cap" };
  }
  return { allowed: true, reason: "ok" };
}

export function recordSubsidy(
  tier: string,
  accountId: string | null,
  amountUsdc: Decimal
): void {
  ensureSubsidyDay();
  subsidyDailyTotal = subsidyDailyTotal.add(amountUsdc);
  subsidyByTier[tier] = toDecimal(subsidyByTier[tier] ?? new Decimal(0)).add(amountUsdc);
  const accountKey = accountId || "unknown";
  subsidyByAccount[accountKey] = toDecimal(subsidyByAccount[accountKey] ?? new Decimal(0)).add(
    amountUsdc
  );
}

export function subsidySummary(): SubsidyState {
  ensureSubsidyDay();
  return {
    dateKey: subsidyDateKey,
    totalUsdc: subsidyDailyTotal,
    byTier: subsidyByTier,
    byAccount: subsidyByAccount
  };
}

export function getRiskState(tier: string): RiskState {
  const key = dayKey();
  if (!stateByTier[tier] || stateByTier[tier].dateKey !== key) {
    stateByTier[tier] = {
      dateKey: key,
      revenueUsdc: new Decimal(0),
      overageUsdc: new Decimal(0),
      notionalUsdc: new Decimal(0)
    };
  }
  return stateByTier[tier];
}

export function applyRiskAccounting(
  tier: string,
  feeUsdc: Decimal,
  premiumUsdc: Decimal,
  notionalUsdc: Decimal,
  hedgeMarginUsdc: Decimal = new Decimal(0)
): { state: RiskState; liquidityDelta: LiquidityState } {
  const state = getRiskState(tier);
  const before = { ...liquidityState };
  const fee = toDecimal(feeUsdc);
  const premium = toDecimal(premiumUsdc);
  const hedgeMargin = toDecimal(hedgeMarginUsdc);

  state.revenueUsdc = state.revenueUsdc.add(fee);
  state.overageUsdc = state.overageUsdc.add(Decimal.max(new Decimal(0), premium.sub(fee)));
  state.notionalUsdc = state.notionalUsdc.add(notionalUsdc);

  const profit = fee.sub(premium);
  liquidityState.revenueUsdc = liquidityState.revenueUsdc.add(fee);
  liquidityState.hedgeSpendUsdc = liquidityState.hedgeSpendUsdc.add(premium);
  liquidityState.hedgeMarginUsdc = liquidityState.hedgeMarginUsdc.add(hedgeMargin);
  liquidityState.profitUsdc = liquidityState.profitUsdc.add(profit);

  const reinvestPct = cachedConfig?.reinvest_pct ?? DEFAULTS.reinvest_pct ?? 0;
  const reservePct = cachedConfig?.reserve_pct ?? DEFAULTS.reserve_pct ?? 0;
  const reinvest = profit.gt(0) ? profit.mul(reinvestPct) : new Decimal(0);
  const reserve = profit.gt(0) ? profit.mul(reservePct) : new Decimal(0);

  liquidityState.reinvestUsdc = liquidityState.reinvestUsdc.add(reinvest);
  liquidityState.reserveUsdc = liquidityState.reserveUsdc.add(reserve);
  liquidityState.liquidityBalanceUsdc = liquidityState.liquidityBalanceUsdc
    .add(fee)
    .sub(premium)
    .sub(hedgeMargin);

  const liquidityDelta = {
    liquidityBalanceUsdc: liquidityState.liquidityBalanceUsdc.minus(before.liquidityBalanceUsdc),
    hedgeSpendUsdc: liquidityState.hedgeSpendUsdc.minus(before.hedgeSpendUsdc),
    hedgeMarginUsdc: liquidityState.hedgeMarginUsdc.minus(before.hedgeMarginUsdc),
    revenueUsdc: liquidityState.revenueUsdc.minus(before.revenueUsdc),
    profitUsdc: liquidityState.profitUsdc.minus(before.profitUsdc),
    reinvestUsdc: liquidityState.reinvestUsdc.minus(before.reinvestUsdc),
    reserveUsdc: liquidityState.reserveUsdc.minus(before.reserveUsdc)
  };
  return { state, liquidityDelta };
}

export function recordRevenue(
  tier: string,
  feeUsdc: Decimal
): { state: RiskState; liquidityDelta: LiquidityState } {
  const state = getRiskState(tier);
  const before = { ...liquidityState };
  const fee = toDecimal(feeUsdc);

  state.revenueUsdc = state.revenueUsdc.add(fee);
  liquidityState.revenueUsdc = liquidityState.revenueUsdc.add(fee);
  liquidityState.profitUsdc = liquidityState.profitUsdc.add(fee);

  const reinvestPct = cachedConfig?.reinvest_pct ?? DEFAULTS.reinvest_pct ?? 0;
  const reservePct = cachedConfig?.reserve_pct ?? DEFAULTS.reserve_pct ?? 0;
  const reinvest = fee.gt(0) ? fee.mul(reinvestPct) : new Decimal(0);
  const reserve = fee.gt(0) ? fee.mul(reservePct) : new Decimal(0);

  liquidityState.reinvestUsdc = liquidityState.reinvestUsdc.add(reinvest);
  liquidityState.reserveUsdc = liquidityState.reserveUsdc.add(reserve);
  liquidityState.liquidityBalanceUsdc = liquidityState.liquidityBalanceUsdc.add(fee);

  const liquidityDelta = {
    liquidityBalanceUsdc: liquidityState.liquidityBalanceUsdc.minus(before.liquidityBalanceUsdc),
    hedgeSpendUsdc: liquidityState.hedgeSpendUsdc.minus(before.hedgeSpendUsdc),
    hedgeMarginUsdc: liquidityState.hedgeMarginUsdc.minus(before.hedgeMarginUsdc),
    revenueUsdc: liquidityState.revenueUsdc.minus(before.revenueUsdc),
    profitUsdc: liquidityState.profitUsdc.minus(before.profitUsdc),
    reinvestUsdc: liquidityState.reinvestUsdc.minus(before.reinvestUsdc),
    reserveUsdc: liquidityState.reserveUsdc.minus(before.reserveUsdc)
  };

  return { state, liquidityDelta };
}

export function riskSummary(): Record<string, RiskState> {
  return stateByTier;
}

export function liquiditySummary(): LiquidityState {
  return liquidityState;
}

export function resetRiskState(): void {
  stateByTier = {};
  const baseLiquidity = toDecimal(
    cachedConfig?.initial_liquidity_usdc ?? DEFAULTS.initial_liquidity_usdc ?? 0
  );
  liquidityState = {
    liquidityBalanceUsdc: baseLiquidity,
    hedgeSpendUsdc: new Decimal(0),
    hedgeMarginUsdc: new Decimal(0),
    revenueUsdc: new Decimal(0),
    profitUsdc: new Decimal(0),
    reinvestUsdc: new Decimal(0),
    reserveUsdc: new Decimal(0)
  };
  subsidyDailyTotal = new Decimal(0);
  subsidyByTier = {};
  subsidyByAccount = {};
  subsidyDateKey = dayKey();
}

export function serializeLiquidityState(state: LiquidityState): Record<string, string> {
  return {
    liquidityBalanceUsdc: state.liquidityBalanceUsdc.toFixed(2),
    hedgeSpendUsdc: state.hedgeSpendUsdc.toFixed(2),
    hedgeMarginUsdc: state.hedgeMarginUsdc.toFixed(2),
    revenueUsdc: state.revenueUsdc.toFixed(2),
    profitUsdc: state.profitUsdc.toFixed(2),
    reinvestUsdc: state.reinvestUsdc.toFixed(2),
    reserveUsdc: state.reserveUsdc.toFixed(2)
  };
}
