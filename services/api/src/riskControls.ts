import { readFile } from "node:fs/promises";

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
  hedge_action_cooldown_ms?: number;
  min_hedge_notional_usdc?: number;
  net_exposure_min_notional_usdc?: number;
  net_exposure_cooldown_ms?: number;
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
  max_leverage_by_tier?: Record<string, { put: number; call: number }>;
  enable_premium_pass_through?: boolean;
  require_user_opt_in_for_pass_through?: boolean;
  pass_through_min_notification_ratio?: number;
  premium_markup_pct_by_tier?: Record<string, number>;
  leverage_markup_pct_by_x?: Record<string, number>;
  drift_tolerance_pct_by_tier?: Record<string, number>;
  drift_tolerance_usdc_by_tier?: Record<string, number>;
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
  revenueUsdc: number;
  overageUsdc: number;
  notionalUsdc: number;
}

export interface LiquidityState {
  liquidityBalanceUsdc: number;
  hedgeSpendUsdc: number;
  hedgeMarginUsdc: number;
  revenueUsdc: number;
  profitUsdc: number;
  reinvestUsdc: number;
  reserveUsdc: number;
}
export interface SubsidyState {
  dateKey: string;
  totalUsdc: number;
  byTier: Record<string, number>;
  byAccount: Record<string, number>;
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
  hedge_action_cooldown_ms: 60000,
  min_hedge_notional_usdc: 250,
  net_exposure_min_notional_usdc: 500,
  net_exposure_cooldown_ms: 120000,
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
  premium_markup_pct_by_tier: {},
  leverage_markup_pct_by_x: {},
  drift_tolerance_pct_by_tier: {},
  drift_tolerance_usdc_by_tier: {},
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
  liquidityBalanceUsdc: DEFAULTS.initial_liquidity_usdc || 0,
  hedgeSpendUsdc: 0,
  hedgeMarginUsdc: 0,
  revenueUsdc: 0,
  profitUsdc: 0,
  reinvestUsdc: 0,
  reserveUsdc: 0
};
let subsidyDailyTotal = 0;
let subsidyByTier: Record<string, number> = {};
let subsidyByAccount: Record<string, number> = {};
let subsidyDateKey = dayKey();

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
    liquidityState.liquidityBalanceUsdc = cachedConfig.initial_liquidity_usdc;
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
  amountUsdc: number,
  iv?: number
): { allowed: boolean; reason: string } {
  ensureSubsidyDay();
  const config = cachedConfig ?? DEFAULTS;
  const baseDailyCap = config.subsidy_daily_cap_usdc ?? DEFAULTS.subsidy_daily_cap_usdc ?? 0;
  const tierCap =
    config.subsidy_tier_daily_cap_usdc?.[tier] ??
    DEFAULTS.subsidy_tier_daily_cap_usdc?.[tier] ??
    baseDailyCap;
  const accountCap = config.subsidy_account_daily_cap_usdc ?? DEFAULTS.subsidy_account_daily_cap_usdc ?? 0;
  const ivThreshold = config.volatility_throttle_iv ?? DEFAULTS.volatility_throttle_iv ?? 0.8;
  const multiplier = config.subsidy_volatility_multiplier ?? DEFAULTS.subsidy_volatility_multiplier ?? 1;
  const highVol = iv !== undefined && iv > ivThreshold;
  const effectiveDailyCap = baseDailyCap * (highVol ? multiplier : 1);
  const effectiveTierCap = tierCap * (highVol ? multiplier : 1);
  const effectiveAccountCap = accountCap * (highVol ? multiplier : 1);

  const tierUsed = subsidyByTier[tier] ?? 0;
  const accountKey = accountId || "unknown";
  const accountUsed = subsidyByAccount[accountKey] ?? 0;

  if (subsidyDailyTotal + amountUsdc > effectiveDailyCap) {
    return { allowed: false, reason: "daily_cap" };
  }
  if (tierUsed + amountUsdc > effectiveTierCap) {
    return { allowed: false, reason: "tier_cap" };
  }
  if (effectiveAccountCap > 0 && accountUsed + amountUsdc > effectiveAccountCap) {
    return { allowed: false, reason: "account_cap" };
  }
  return { allowed: true, reason: "ok" };
}

export function recordSubsidy(tier: string, accountId: string | null, amountUsdc: number): void {
  ensureSubsidyDay();
  subsidyDailyTotal += amountUsdc;
  subsidyByTier[tier] = (subsidyByTier[tier] ?? 0) + amountUsdc;
  const accountKey = accountId || "unknown";
  subsidyByAccount[accountKey] = (subsidyByAccount[accountKey] ?? 0) + amountUsdc;
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
    stateByTier[tier] = { dateKey: key, revenueUsdc: 0, overageUsdc: 0, notionalUsdc: 0 };
  }
  return stateByTier[tier];
}

export function applyRiskAccounting(
  tier: string,
  feeUsdc: number,
  premiumUsdc: number,
  notionalUsdc: number,
  hedgeMarginUsdc = 0
): { state: RiskState; liquidityDelta: LiquidityState } {
  const state = getRiskState(tier);
  const before = { ...liquidityState };
  state.revenueUsdc += feeUsdc;
  state.overageUsdc += Math.max(0, premiumUsdc - feeUsdc);
  state.notionalUsdc += notionalUsdc;
  const profit = feeUsdc - premiumUsdc;
  liquidityState.revenueUsdc += feeUsdc;
  liquidityState.hedgeSpendUsdc += premiumUsdc;
  liquidityState.hedgeMarginUsdc += hedgeMarginUsdc;
  liquidityState.profitUsdc += profit;
  const reinvestPct = cachedConfig?.reinvest_pct ?? DEFAULTS.reinvest_pct ?? 0;
  const reservePct = cachedConfig?.reserve_pct ?? DEFAULTS.reserve_pct ?? 0;
  const reinvest = profit > 0 ? profit * reinvestPct : 0;
  const reserve = profit > 0 ? profit * reservePct : 0;
  liquidityState.reinvestUsdc += reinvest;
  liquidityState.reserveUsdc += reserve;
  liquidityState.liquidityBalanceUsdc += feeUsdc - premiumUsdc - hedgeMarginUsdc;
  const liquidityDelta = {
    liquidityBalanceUsdc: liquidityState.liquidityBalanceUsdc - before.liquidityBalanceUsdc,
    hedgeSpendUsdc: liquidityState.hedgeSpendUsdc - before.hedgeSpendUsdc,
    hedgeMarginUsdc: liquidityState.hedgeMarginUsdc - before.hedgeMarginUsdc,
    revenueUsdc: liquidityState.revenueUsdc - before.revenueUsdc,
    profitUsdc: liquidityState.profitUsdc - before.profitUsdc,
    reinvestUsdc: liquidityState.reinvestUsdc - before.reinvestUsdc,
    reserveUsdc: liquidityState.reserveUsdc - before.reserveUsdc
  };
  return { state, liquidityDelta };
}

export function recordRevenue(
  tier: string,
  feeUsdc: number
): { state: RiskState; liquidityDelta: LiquidityState } {
  const state = getRiskState(tier);
  const before = { ...liquidityState };
  state.revenueUsdc += feeUsdc;
  liquidityState.revenueUsdc += feeUsdc;
  liquidityState.profitUsdc += feeUsdc;
  const reinvestPct = cachedConfig?.reinvest_pct ?? DEFAULTS.reinvest_pct ?? 0;
  const reservePct = cachedConfig?.reserve_pct ?? DEFAULTS.reserve_pct ?? 0;
  const reinvest = feeUsdc > 0 ? feeUsdc * reinvestPct : 0;
  const reserve = feeUsdc > 0 ? feeUsdc * reservePct : 0;
  liquidityState.reinvestUsdc += reinvest;
  liquidityState.reserveUsdc += reserve;
  liquidityState.liquidityBalanceUsdc += feeUsdc;
  const liquidityDelta = {
    liquidityBalanceUsdc: liquidityState.liquidityBalanceUsdc - before.liquidityBalanceUsdc,
    hedgeSpendUsdc: liquidityState.hedgeSpendUsdc - before.hedgeSpendUsdc,
    hedgeMarginUsdc: liquidityState.hedgeMarginUsdc - before.hedgeMarginUsdc,
    revenueUsdc: liquidityState.revenueUsdc - before.revenueUsdc,
    profitUsdc: liquidityState.profitUsdc - before.profitUsdc,
    reinvestUsdc: liquidityState.reinvestUsdc - before.reinvestUsdc,
    reserveUsdc: liquidityState.reserveUsdc - before.reserveUsdc
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
  const baseLiquidity = cachedConfig?.initial_liquidity_usdc ?? DEFAULTS.initial_liquidity_usdc ?? 0;
  liquidityState = {
    liquidityBalanceUsdc: baseLiquidity,
    hedgeSpendUsdc: 0,
    hedgeMarginUsdc: 0,
    revenueUsdc: 0,
    profitUsdc: 0,
    reinvestUsdc: 0,
    reserveUsdc: 0
  };
  subsidyDailyTotal = 0;
  subsidyByTier = {};
  subsidyByAccount = {};
  subsidyDateKey = dayKey();
}
