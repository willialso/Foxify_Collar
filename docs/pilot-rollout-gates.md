# Pilot Rollout Plan and Acceptance Gates

This document tracks rollout gates for the `/pilot/*` API surface only.

## Phase A: Contract and deployment hygiene

- Acceptance/UAT script matches current pilot behavior:
  - tenant-scoped identity (no `userId` parameter)
  - server-anchored trigger (`entrySnapshot`), not client entry input
  - fixed 7-day tenor on activation
- Pilot deployment profile disables legacy loop workloads:
  - `LOOP_INTERVAL_MS=0`
  - `MTM_INTERVAL_MS=0`

## Phase B: Pricing and execution quality (Deribit test mode)

- Quote uses canonical reference anchor + validated venue quote.
- Quote-lock activation enforces context integrity (`quote_mismatch_*` protections).
- Full-coverage checks are enforced against executed quantity.

## Phase C: Accounting and settlement integrity

- Settlement posting remains idempotent under retries and concurrent requests.
- Expiry resolution writes protection + payout_due ledger consistently.
- Admin export and metrics remain internally consistent.

## Phase D: FalconX crossover readiness

- FalconX quote/execute semantics (price units/sign conventions) are confirmed and documented.
- RFQ lifecycle handling is validated (`rfq_id`, `quote expiry`, `t_retry`, `close_rfq`).
- Error mapping covers RFQ limits/cooldowns and account margin failures.

## Pilot acceptance gates (before client-facing expansion)

1. Quote/activate/proof/admin UAT passes against current API contract.
2. Activation success remains stable with no execution regression.
3. Tenant daily cap enforcement is consistent at UTC reset boundaries.
4. Reconciliation export totals match admin metrics for scoped pilot records.
5. No unresolved `awaiting_expiry_price` backlog after scheduled retries.

## Rollout-day runbook: daily usage backfill

When deploying the atomic daily cap reservation model (`pilot_daily_usage`) mid-day, backfill current UTC-day usage once to prevent temporary cap drift.

```sql
WITH day_bounds AS (
  SELECT date_trunc('day', now() AT TIME ZONE 'UTC')::date AS day_start
),
daily_agg AS (
  SELECT
    p.user_hash,
    (p.created_at AT TIME ZONE 'UTC')::date AS day_start,
    COALESCE(SUM(p.protected_notional), 0)::numeric(28,10) AS used_notional
  FROM pilot_protections p
  JOIN day_bounds d
    ON (p.created_at AT TIME ZONE 'UTC')::date = d.day_start
  GROUP BY p.user_hash, (p.created_at AT TIME ZONE 'UTC')::date
)
INSERT INTO pilot_daily_usage (user_hash, day_start, used_notional)
SELECT user_hash, day_start, used_notional
FROM daily_agg
ON CONFLICT (user_hash, day_start)
DO UPDATE SET used_notional = EXCLUDED.used_notional;
```

Notes:
- This statement is idempotent and safe to re-run.
- Scope is current UTC day only.

## Optional pilot campaign window (start + hard stop)

To enforce a strict pilot campaign window for new quote/activate requests:

- `PILOT_ENFORCE_WINDOW=true`
- `PILOT_START_AT=<ISO-8601 UTC timestamp>`
- `PILOT_DURATION_DAYS=30`

Behavior:
- before start: `reason=pilot_not_started`
- at/after end: `reason=pilot_window_closed`
- existing protections continue through monitor/expiry/admin flows.
