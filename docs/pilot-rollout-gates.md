# Pilot Rollout Plan and Acceptance Gates

## Phase 0 (same day)

- Lock pricing to:
  - `final_fee = max(tier_floor_fee, hedge_premium * (1 + tier_markup + leverage_markup))`
- Keep CTC in shadow mode (`ctc_shadow_mode=true`).
- Keep pass-through + floor as charge basis for all pilot tiers.
- Enforce tier cohort minimum notionals. Out-of-cohort requests return `reason=tier_notional_min`.

## Phase 1 (2-3 days)

- Validate CTC exposure semantics with fixed-notional test matrix.
- Validate CTC guardrails:
  - max multiple of hedge premium
  - max percent of protected notional
- Validate tenor control behavior and fallback attribution.

## Phase 2 (canary)

- Re-enable CTC fee influence only if:
  - `ctc_shadow_mode=false`
  - `ctc_price_override_enabled=true`
  - bounds are respected
- Canary on selected tiers and 5-10% traffic.

## Acceptance Gates (before full pilot)

1. No premium caps on pass-through pricing (policy consistency check).
2. Quote-to-audit reconciliation error `< 0.5%` for coverage economics fields.
3. Tenor drift > 2 days only when `tenorReason=tenor_fallback`.
4. Activation success remains stable with no execution regression.
