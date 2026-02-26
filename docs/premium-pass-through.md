# Premium Pass-Through System

## Overview
When market volatility pushes hedge premiums above base fees, the platform charges users the
hedge premium plus configured markup without caps. This keeps pricing transparent and
ensures the platform remains sustainable when hedging costs rise.

## Pricing Rule

`final_fee = max(tier_floor_fee, hedge_premium * (1 + tier_markup + leverage_markup))`

This is the only customer-facing fee path in pilot mode.

## CTC (Coverage-to-Coverage) in Pilot

- CTC runs in **shadow mode** as a risk signal.
- CTC does **not** directly override customer fees in initial pilot.
- CTC outputs are guard-railed before any future pricing use:
  - `ctc_fee <= ctc_max_multiple_of_hedge_premium`
  - `ctc_fee <= ctc_max_pct_notional * protected_notional`
- Low-quality legs (near-zero intrinsic value at floor) are filtered out in CTC leg selection.

## Tenor Control

- Default behavior: choose nearest expiry within configured tolerance (default ±2 days).
- If no liquidity inside tolerance, quote can expand tenor and sets `tenorReason=tenor_fallback`.
- Widget displays selected tenor before activation.

## Reconciliation Fields (per coverage)

- `quotedFeeUsdc`
- `collectedFeeUsdc`
- `hedgeSpendUsdc`
- `grossMarginUsdc = collectedFeeUsdc - hedgeSpendUsdc`
- `pricingReason`

## Tier Eligibility (Pilot Cohorts)

Pilot quoting enforces tier minimum protected notional thresholds:

- Pro (Bronze): 1,000 USDC
- Pro (Silver): 2,500 USDC
- Pro (Gold): 5,000 USDC
- Pro (Platinum): 10,000 USDC

If a request is below a tier threshold, the API returns `reason=tier_notional_min`.

Pilot does not enforce a fee-to-premium cap. Pass-through remains uncapped by policy.

## User Experience

### Normal Quote (Premium <= 1.25x Base Fee)
User pays the base fee. Platform margin remains positive.

### Pass-Through (When Premium + Markup Exceeds Floor)
User pays premium + markup. This supports full hedging and preserves margin discipline.

## CEO Talking Points

- "We charge premium + markup with full transparency."
- "No caps, no hidden subsidies."
- "Every quote follows one consistent pricing rule."
- "Every decision is logged for compliance."
