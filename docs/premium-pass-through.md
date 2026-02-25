# Premium Pass-Through System

## Overview
When market volatility pushes hedge premiums above base fees, the platform charges users the
hedge premium plus configured markup without caps. This keeps pricing transparent and
ensures the platform remains sustainable when hedging costs rise.

## Pricing Rule

`final_fee = max(tier_floor_fee, hedge_premium * (1 + tier_markup + leverage_markup))`

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
