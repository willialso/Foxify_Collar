import Decimal from "decimal.js";
import type { RiskControlsConfig } from "./riskControls";

function findLeverageMarkup(
  leverage: number | undefined,
  multipliers?: Record<string, number>
): number | null {
  if (!multipliers) return null;
  const lev = Number(leverage ?? 1);
  const entries = Object.entries(multipliers)
    .map(([key, value]) => ({ leverage: Number(key), multiplier: Number(value) }))
    .filter((entry) => Number.isFinite(entry.leverage) && Number.isFinite(entry.multiplier))
    .sort((a, b) => a.leverage - b.leverage);
  if (!entries.length) return null;
  let selected = entries[0].multiplier;
  for (const entry of entries) {
    if (entry.leverage <= lev) selected = entry.multiplier;
  }
  return Number.isFinite(selected) ? selected : null;
}

export function resolvePremiumMarkupPctForQuote(
  tierName: string,
  leverage: number | undefined,
  controls: RiskControlsConfig
): Decimal {
  const demoOverrideEnabled = controls.vc_demo_override_enabled === true;
  const tierMarkupMap =
    demoOverrideEnabled &&
    controls.vc_demo_override_premium_markup_pct_by_tier &&
    Object.keys(controls.vc_demo_override_premium_markup_pct_by_tier).length > 0
      ? controls.vc_demo_override_premium_markup_pct_by_tier
      : controls.premium_markup_pct_by_tier;
  const leverageMarkupMap =
    demoOverrideEnabled &&
    controls.vc_demo_override_leverage_markup_pct_by_x &&
    Object.keys(controls.vc_demo_override_leverage_markup_pct_by_x).length > 0
      ? controls.vc_demo_override_leverage_markup_pct_by_x
      : controls.leverage_markup_pct_by_x;

  // Preserve existing production behavior unless explicit demo override is enabled.
  if (!demoOverrideEnabled && tierName === "Pro (Bronze)") {
    return new Decimal(0);
  }

  const tierMarkupRaw = Number(tierMarkupMap?.[tierName] ?? 0);
  const tierMarkupPct =
    Number.isFinite(tierMarkupRaw) && tierMarkupRaw > 0 ? tierMarkupRaw : 0;
  const leverageMarkupRaw = findLeverageMarkup(leverage, leverageMarkupMap);
  const leverageMarkupPct =
    Number.isFinite(leverageMarkupRaw) && (leverageMarkupRaw as number) > 0
      ? (leverageMarkupRaw as number)
      : 0;
  return new Decimal(tierMarkupPct).add(new Decimal(leverageMarkupPct));
}
