# Atticus Platform Technical Documentation (Foxify CTO Edition)

| Field | Value |
| --- | --- |
| Version | 2026-02-05 |
| Status | MVP Integration Package |
| Audience | Foxify CTO, Engineering, Security, Ops |
| Confidentiality | Partner-Confidential (see Section 16) |
| Repository | /workspace (legacy name: foxify_collar) |

## Table of Contents
1. Executive Summary (1 page)
2. Scope and Responsibilities
3. System Architecture
4. Core Workflows and Data Flows
5. API Reference
6. Data Model and Persistence
7. Pricing, Risk, and Hedging Models
8. External Integrations
9. Security, Compliance, and Threat Model
10. Observability and Operations
11. Deployment and Infrastructure
12. Testing and QA
13. Roadmap
14. Glossary and Error Codes
15. Disclosure and IP Protection
16. Technical Appendix (Optional under NDA)

---

## 1. Executive Summary (1 page)

### 1.1 Platform Overview
Atticus is a B2B BTC options protection overlay designed for institutional and funded-trader programs. It provides fixed-fee protective puts (and call protection where tier rules permit), computes risk in real time with MTM crediting, and executes hedges with automatic rolling and renewal. The platform is delivered as a private API plus an embeddable React widget for activation and monitoring.

The current codebase is implemented in TypeScript/Node using Fastify for the API layer and a dedicated hedging engine that uses Decimal.js for all financial calculations. The system integrates with Deribit as the primary execution venue and can compare pricing against Bybit for faster quote delivery and price competitiveness.

### 1.2 MVP Scope and Readiness
The MVP is intentionally focused on BTC protection and operational transparency:
- BTC-only asset validation at the API boundary.
- Fixed-fee protection with liquidity gating and fixed-floor alignment.
- Rolling hedge control loop with buffer targets and hysteresis.
- Auto-renew flow to maintain continuous protection.
- Premium pass-through with tier/leverage caps and premium-floor enforcement; Bronze supports put and call protection when floor constraints are satisfied.
- Append-only audit logging and file-based state snapshots for portability.
- MTM audit trail includes per-position MTM events and coverage ratio tracking.
- Paper mode for safe simulation and QA.

MVP deployment is designed to run inside the Foxify environment behind a trusted API gateway. Authentication, rate limiting, and network access controls are expected at the edge, while the Atticus API remains private to Foxify infrastructure.

### 1.3 Technical Soundness Highlights
- Financial precision enforced by Decimal.js throughout the hedging engine.
- Liquidity gates (spread, slippage, minimum size) and leverage caps by tier.
- Risk controls and fee floors loaded from external configuration.
- Cache-aware quote pipeline with fuzzy buckets and TTL for deterministic latency.
- Clear audit trail for coverage activation, hedge actions, and renewals.
- Defensive failure behavior: invalid inputs or unsafe conditions return `no_quote`.

### 1.4 Integration Fit for Foxify
Atticus is structured to align with Foxify operational needs:
- API core with explicit audit export and control loop endpoints.
- Clear integration contract for portfolio ingestion and coverage reporting.
- Self-contained UI widget for activation and monitoring with audit dashboards.
- Separate risk engine module for independent validation and testing.

---

## 2. Scope and Responsibilities

### 2.1 In-Scope for MVP
- Fixed-fee protective put pricing and execution for BTC.
- Drawdown buffer computation with MTM crediting.
- Rolling hedge control loop and auto-renew.
- Audit logging, coverage tracking, and operator dashboards.
- Integration endpoints for portfolio ingestion and coverage reporting.

### 2.2 External or Partner Responsibilities
These are intentionally outside Atticus scope and handled by Foxify or existing partner systems:
- KYC/AML and client onboarding.
- Custody, settlement, and fiat/crypto transfers.
- User authentication, session management, and access control at the edge.
- Portfolio data correctness and account-level governance.

### 2.3 Phase 2 and Phase 3 Expansion (Planned)
- Persistent database (e.g., Postgres) replacing file-based state.
- Full API gateway auth and rate limiting with per-tenant policies.
- Metrics exporters and SLO dashboards.
- Optional on-chain settlement hooks (ICP/Bitlayer) for auditability.
- Expanded asset coverage beyond BTC.

---

## 3. System Architecture

### 3.1 High-Level Architecture
```text
[Foxify UI Widget] <--> [Atticus API] <--> [Hedging Engine]
        |                     |                |
        |                     +--> [Audit + State Logs]
        |                     +--> [Deribit REST/WS]
        |                     +--> [Bybit REST (pricing)]
        |                     +--> [Webhook Alerts]
        |                                     |
        +-------------------------------------+--> [Deribit REST/WS]
```

### 3.2 Component Breakdown
**Frontend (React Widget)**
- Path: `apps/web/`
- `App.tsx` orchestrates portfolio fetching, quote preview, activation, and audit modal display.
- `AuditDashboard.tsx` renders audit summary data from `/audit/summary`.
- `positionSource.ts` provides adapters for demo and partner position sources.

**API Service (Fastify)**
- Path: `services/api/src/server.ts`
- Hosts all endpoints and internal in-memory state:
  - `activeCoverages` (Map)
  - `portfolioSnapshots` (Map)
  - `hedgeLedger` (Map)
- Runs periodic loops when configured: `/loop/tick` and MTM refresh.

**Hedging Engine**
- Path: `services/hedging/`
- Responsible for risk summary, option selection, rolling hedges, and scoring.
- Uses Decimal.js end-to-end for all monetary values.

**Connectors**
- Path: `services/connectors/`
- Deribit REST + WS integration.
- Bybit pricing adapter under `services/api/src/bybitAdapter.ts`.

**Shared Types and Config**
- `packages/shared/` for schemas and types.
- `configs/` for funded levels and risk controls.

### 3.3 Runtime State and Persistence
Runtime state is held in memory for low latency. Persistent artifacts are written to disk for auditability and portability:
- `logs/audit.log` (JSONL)
- `logs/coverages.json`
- `logs/coverage-ledger.json`
- `logs/hedge-ledger.json`

This structure is intentionally modular to enable a future migration to a dedicated database without redesigning the API contract.

---

## 4. Core Workflows and Data Flows

### 4.1 Protection Quote and Activation
**Flow**
1. UI submits `POST /put/quote`.
2. API validates asset, leverage, and tier constraints.
3. Hedging engine selects an option that fits the fixed fee and liquidity gates.
4. API places an order via `POST /deribit/order` (paper or live).
5. Coverage and audit records are persisted via `POST /audit/export`.

**Validation and Safety**
- Asset must be BTC.
- Leverage capped by `risk_controls.json`.
- Spread/slippage and minimum size thresholds enforced.
- Invalid or unsafe inputs return `{ status: "no_quote" }`.

**Caching**
- Quote responses are cached across all status types.
- Cache keys use fuzzy buckets (spot rounded to $500, drawdown rounded to 5%, days rounded to whole days).
- TTL is env-configurable and can be tuned for demo or production latency targets.

### 4.2 Hedge Control Loop
**Flow**
1. `POST /loop/tick` triggers a cycle.
2. `GET /risk/summary` computes equity and drawdown buffer.
3. `evaluateRollingHedge()` determines whether to increase or decrease exposure.
4. Orders are routed through `ExecutionRegistry` to Deribit.
5. Hedge actions and orders are recorded to audit logs.

**Decision Logic**
- If buffer < target: increase hedge.
- If buffer > target + hysteresis: decrease hedge.
- Otherwise: no action.
Intermittent selection modes (shadow/live) can be enabled via risk controls and are logged as `intermittent_hedge_eval`.

### 4.3 Auto-Renew
**Flow**
1. `POST /put/auto-renew` checks expiry window.
2. If inside window, a renewal quote is generated and executed.
3. A `coverage_renewed` audit event is recorded.

### 4.4 Audit Logging and Reporting
**Flow**
- All critical events are appended to `logs/audit.log` in JSONL format.
- `GET /audit/summary` provides aggregate views for the UI dashboard.
- `GET /audit/logs` allows raw event review with limits.

**Executive audit view (minimum set)**
- `coverage_activated` (includes `coverageLegs` with instrument, size, venue, option type, and strike)
- `coverage_renewed`
- `hedge_action`
- `hedge_order`
- `mtm_credit`
- `mtm_position` (per-position MTM snapshot with coverage ratio)
- `demo_credit` (demo-only margin credit events)
- `option_payout`
- `coverage_expired`

**Internal audit view (operator)**
- `put_quote`
- `pass_through_gate`
- `premium_pass_through`
- `risk_budget_update`
- `liquidity_update`
- `execution_quality`
- `renewal_decision`
- `intermittent_hedge_eval` (shadow/live selection diagnostics)
- `hedge_action_skipped`
- `close_blocked`

Executive view is intentionally minimal and omits platform profitability; internal view includes liquidity and execution analytics.
Key MTM payload fields:
- `mtm_position`: `coverageId`, `positionId`, `positionPnlUsdc`, `hedgeMtmUsdc`, `equityUsdc`, `drawdownBufferUsdc`, `coverageRatio`
- `demo_credit`: `coverageId`, `positionId`, `creditUsdc`, `bufferUsdc` (demo-only)

### 4.5 Failure Modes and Safe Behavior
The system prioritizes safe, explicit failure modes:
- Untrusted or invalid inputs yield `no_quote`.
- Liquidity checks prevent thin or wide-spread execution.
- Stale data is avoided via TTL and explicit max-age checks.

---

## 5. API Reference

### 5.1 API Architecture
- **Base URL**: `http://<host>:4100`
- **Auth**: API is designed for private network access. Foxify edge gateway is expected to enforce auth and rate limiting.
- **Error format**: `{ status: "error"|"no_quote", reason: "..." }`

### 5.2 Endpoints

#### GET /health
Purpose: Service health check  
Response:
```json
{ "status": "ok" }
```

#### POST /portfolio/ingest
Purpose: Store portfolio positions for an account  
Request:
```json
{
  "accountId": "string",
  "positions": [
    { "asset": "BTC", "side": "long|short", "entryPrice": 0, "size": 0, "leverage": 0 }
  ],
  "source": "string (optional)"
}
```
Response:
```json
{ "status": "ok", "accountId": "demo", "count": 1, "updatedAt": "ISO8601" }
```

#### GET /portfolio/positions
Purpose: Retrieve stored positions  
Query: `accountId` (default `demo`)

#### GET /coverage/active
Purpose: List non-expired coverages  
Query: `accountId` (default `demo`)

#### GET /coverage/report
Purpose: Match latest coverage per position  
Query: `accountId`

#### GET /integration/handshake
Purpose: Integration status  
Response:
```json
{ "status": "ok", "mode": "demo|production", "approved": false, "timestamp": "ISO8601" }
```

#### GET /risk/summary
Purpose: Compute equity + drawdown buffer  
Query:
- `cashUsdc`, `positionPnlUsdc`, `hedgeMtmUsdc`, `drawdownLimitUsdc`, `initialBalanceUsdc`
- `maxMtmAgeMs` (default 15000)

#### GET /deribit/instruments
Purpose: List Deribit BTC options  
Response: Deribit API payload

#### GET /deribit/ticker
Purpose: Deribit ticker for instrument  
Query: `instrument`

#### POST /deribit/order
Purpose: Place Deribit order (paper or live)  
Request body includes:
```json
{
  "instrument": "string",
  "amount": 0,
  "side": "buy|sell",
  "type": "market|limit",
  "price": 0,
  "venue": "deribit",
  "coverageId": "string",
  "notionalUsdc": 0,
  "hedgeType": "option|perp",
  "feeUsdc": 0,
  "tierName": "string",
  "premiumUsdc": 0,
  "spotPrice": 0,
  "leverage": 0,
  "feeRecognized": true,
  "subsidyUsdc": 0,
  "reason": "string",
  "accountId": "string",
  "intent": "open|close|hedge",
  "drawdownLimitUsdc": "string",
  "initialBalanceUsdc": "string",
  "assets": ["BTC"],
  "asset": "BTC",
  "positionPnlUsdc": "string",
  "hedgeMtmUsdc": "string",
  "floorPrice": 0
}
```
Notes:
- `intent=close` requires drawdown inputs; closes are blocked if buffer is positive.
- Side effects update hedge ledger and audit events.

#### GET /deribit/positions
Purpose: Return Deribit positions (BTC)

#### GET /pricing/btc
Purpose: BTC index price

#### GET /pricing/iv/:asset
Purpose: Return implied volatility snapshot  
Example response:
```json
{ "asset": "BTC", "iv": 0.5, "ivHedge": 0.6 }
```

#### POST /pricing/ctc
Purpose: Compute coverage-to-coverage (CTC) fee  
Request:
```json
{
  "tierName": "string",
  "asset": "BTC",
  "spotPrice": 0,
  "drawdownFloorPct": 0,
  "positionSize": 0,
  "leverage": 0
}
```
Response:
```json
{ "status": "ok", "feeUsdc": "20.00", "reason": "ctc_safety" }
```

#### GET /risk/mtm
Purpose: Return MTM components computed from Deribit positions
Notes:
- When `ALLOW_DERIBIT_PRIVATE_MTM=true`, MTM can use authenticated Deribit positions; otherwise the API operates in public/paper mode.

#### POST /put/preview
Purpose: Async quote preview with cache  
Response:
- Cached quote or `{ "status": "pending" }`

#### POST /put/quote
Purpose: Price fixed-fee protective put  
Behavior notes:
- BTC only.
- Leverage limit via `normalizeLeverage`.
- Spread/slippage thresholds from `risk_controls.json`.
- Bronze tier supports put and call protection when premium-floor constraints are satisfied.
- Premium pass-through can be enabled per request (`allowPremiumPassThrough`) and gated by tier/leverage caps; responses may return `pass_through`, `pass_through_capped`, or `premium_floor` status variants.
- Dual-venue pricing uses a hybrid fast path (Bybit may respond first).
- All responses are cached and logged with a hit-rate indicator.

Status variants (observed):
- `ok`
- `pass_through`
- `pass_through_capped`
- `premium_floor`
- `no_quote`
- `error`

#### POST /put/auto-renew
Purpose: Renew protection near expiry  
Behavior:
- Returns `{ status: "too_early" }` if not in renewal window.

#### POST /put/auto-renew/schedule
Purpose: Scheduler helper for renewals  
Request: `{ enabled, nextExpiryIso, renewWindowMinutes, payload }`

#### GET /risk/daily-summary
Purpose: Return internal risk counters

#### POST /loop/tick
Purpose: Single-step risk + hedge control loop  
Request includes account info, hedge settings, and exposure list.

#### POST /audit/export
Purpose: Persist audit payload and activate coverage
Side effects: emits `coverage_activated` with `coverageLegs` and seeds `coverage-ledger.json` for MTM attribution.

#### POST /admin/reset
Purpose: Clear audit logs and reset in-memory state

#### GET /audit/logs
Purpose: Return audit log entries  
Query: `limit`, `showAll`

#### GET /audit/summary
Purpose: Return audit summary for dashboards  
Query: `mode=exec|internal`

#### POST /hedge/roll
Purpose: Rolling hedge decision + execute

---

## 6. Data Model and Persistence

### 6.1 Storage Model (MVP)
The MVP uses file-based JSON persistence for auditability and portability. In-memory maps are the primary runtime store, with periodic writes for recovery and review.

### 6.2 Audit Log (JSONL)
File: `logs/audit.log`  
Schema:
```json
{
  "ts": "ISO8601",
  "event": "coverage_activated|hedge_order|...",
  "payload": {}
}
```

### 6.3 Active Coverages
File: `logs/coverages.json`  
Schema: serialized array of `[coverageId, CoverageRecord]`
```json
{
  "coverageId": "string",
  "expiryIso": "ISO8601",
  "positions": [
    { "id": "string", "asset": "BTC", "side": "long|short", "marginUsd": 0, "leverage": 0, "entryPrice": 0 }
  ]
}
```

### 6.4 Coverage Ledger (MTM Attribution)
File: `logs/coverage-ledger.json`  
Purpose: Append-only ledger entries tying coverage IDs to selected venue, hedge legs, and MTM attribution snapshots used for audit and coverage ratio checks.  
Schema (conceptual):
```json
{
  "coverageId": "string",
  "selectedVenue": "deribit|bybit",
  "coverageLegs": [
    { "instrument": "string", "size": 0, "optionType": "put|call", "strike": 0, "venue": "string" }
  ],
  "equityUsdc": "Decimal",
  "drawdownBufferUsdc": "Decimal",
  "coverageRatio": "Decimal",
  "timestamp": "ISO8601"
}
```

### 6.5 Hedge Ledger
File: `logs/hedge-ledger.json`
```json
{
  "ledger": [
    ["INSTRUMENT", { "size": "Decimal", "avgCostUsdc": "Decimal" }]
  ],
  "realizedPnl": "Decimal",
  "timestamp": "ISO8601"
}
```

### 6.6 Migration Path
The data contract is intentionally explicit to support migration to Postgres or another durable store without breaking API semantics. Audit events remain append-only to support forensic review.

---

## 7. Pricing, Risk, and Hedging Models

### 7.1 Fixed-Fee Option Selection
The platform selects a protective option whose premium fits under the fixed fee while meeting liquidity constraints. Option type (put or call) is derived from position side and tier rules.

Pseudocode (simplified):
```typescript
floorStrike = spotPrice * (1 - drawdownFloorPct)
if premiumTotal > fixedPriceUsdc: reject
if spreadPct > maxSpreadPct: reject
if availableSize < requiredSize: reject
```

### 7.2 Liquidity Gates
Liquidity gates are enforced at quote time:
- Max spread percent
- Max slippage percent
- Minimum available size

### 7.3 Premium Pass-Through and Floor
The system supports premium pass-through when `allowPremiumPassThrough=true` and the risk controls permit it. The pass-through gate caps user premium by tier/leverage while preserving hedge coverage. Responses can include:
- `pass_through`: premium accepted within cap.
- `pass_through_capped`: premium capped and remaining portion treated as subsidy.
- `premium_floor`: rejected because the premium is below the configured floor.

Premium-floor enforcement uses `premium_floor_ratio` and `min_fee_usdc_by_tier` to avoid under-priced protection, especially in low IV regimes.

### 7.4 CTC Fee (Coverage-to-Coverage)
`POST /pricing/ctc` computes a safety fee based on tier and volatility regime, adding a margin for operational buffer.

### 7.5 Rolling Hedge Logic
Rolling hedges maintain the drawdown buffer with hysteresis:
- Increase hedge if buffer < target.
- Decrease hedge if buffer > target + hysteresis.
- Optional net-exposure hedging can be invoked when exposures are provided, recorded as `hedge_action` with a `net_exposure` reason.

### 7.6 Risk Controls (Config-Driven)
Risk controls are loaded from `configs/risk_controls.json` and merged with defaults in `services/api/src/riskControls.ts`. Key parameter families:
- **Leverage and tier caps**: `max_leverage`, `max_leverage_by_tier`
- **Subsidy limits**: `subsidy_daily_cap_usdc`, `subsidy_account_daily_cap_usdc`
- **Premium floors and minimum fees**: `premium_floor_ratio`, `min_fee_usdc_by_tier`
- **Premium markups**: `premium_markup_pct_by_tier`, `leverage_markup_pct_by_x`
- **Pass-through controls**: `enable_premium_pass_through`, `require_user_opt_in_for_pass_through`, `pass_through_cap_by_leverage`, `pass_through_cap_by_tier`, `pass_through_min_notification_ratio`
- **Drift tolerances**: `drift_tolerance_pct_by_tier`, `drift_tolerance_usdc_by_tier`
- **CTC controls**: `ctc_enabled`, `ctc_margin_by_tier`, `ctc_ops_buffer_usdc_by_tier`, `ctc_max_snapshot_age_ms`, `ctc_price_buffer_pct`
- **IV regime thresholds**: `fee_iv_regime_thresholds` (`low`, `high`)
- **Dynamic cap uplift**: `dynamic_cap_enabled`, `dynamic_cap_max_uplift_pct`, `dynamic_cap_liquidity_ratio_low`, `dynamic_cap_liquidity_ratio_high`, `dynamic_cap_iv_uplift_pct_normal`, `dynamic_cap_iv_uplift_pct_high`
- **Intermittent hedge controls**: `phase3_rollout_enabled`, `phase3_safety_guard_enabled`, `intermittent_analytics_enabled`, `intermittent_selection_shadow_enabled`, `intermittent_selection_live_enabled`, `intermittent_selection_size_tolerance_pct`, `intermittent_profit_threshold_enabled`, `intermittent_profit_min_improvement_usdc`, `intermittent_profit_min_improvement_ratio`, `intermittent_profit_critical_buffer_pct`

### 7.7 Financial Precision
All monetary calculations in the hedging engine use Decimal.js to avoid float rounding errors and ensure deterministic results.

---

## 8. External Integrations

### 8.1 Deribit (Primary Venue)
- REST + WS for pricing, instruments, and execution.
- Paper mode supported for QA and simulation.
- Primary execution venue for options and perp hedges.

### 8.2 Bybit (Secondary Pricing)
- Used for hybrid quote fast path and price comparison.
- Enables faster quotes and cost competitiveness analytics.

### 8.3 Price and IV Sources
- Deribit index price and IV ladder snapshots are used for pricing.
- Optional integration with external oracles (e.g., Torram) is planned for production hardening.

### 8.4 Notifications
- Webhook alerts via `sendWebhookAlert()` for critical events or loop actions.

### 8.5 Optional On-Chain Hooks (Phase 3)
The repository contains placeholder contract interfaces for future settlement hooks. These are optional and not required for the MVP integration.

---

## 9. Security, Compliance, and Threat Model

### 9.1 Trust Boundaries
The Atticus API is intended to run inside Foxify infrastructure with access controlled at the network edge. Internal endpoints are not designed for public exposure.

### 9.2 Authentication and Authorization
MVP deployments should use Foxify's gateway or API management layer for:
- Authentication (SSO/JWT)
- Tenant isolation
- Rate limiting

### 9.3 Key Management
Venue credentials are provisioned via the Foxify secrets manager and injected at runtime. Credential material is intentionally omitted from this document. For production, keys should be rotated and scoped with least-privilege access.

### 9.4 Data Security and Privacy
- No PII is required by the Atticus API in MVP scope.
- Audit logs and state snapshots are stored locally; encryption-at-rest should be enforced at the host or volume level.

### 9.5 Threat Model (Selected)
| Risk | Mitigation |
| --- | --- |
| Price feed outage or staleness | TTL checks, cache controls, safe `no_quote` responses |
| Execution slippage | Spread/slippage gating, minimum size checks |
| API abuse | Gateway auth + rate limits, private network access |
| Venue downtime | Fallback to safe fail, alerting via webhook |
| Data tampering | Append-only audit log, explicit export events |

### 9.6 Compliance Scope
Atticus does not perform KYC/AML, custody, or settlement. Those remain the responsibility of Foxify or partner infrastructure.

---

## 10. Observability and Operations

### 10.1 Logging
- Audit log: `logs/audit.log` (JSONL)
- Console logs via Fastify logger and `console.log`
Audit event taxonomy is defined in Section 4.4 and includes MTM attribution and intermittent hedging diagnostics.

### 10.2 Metrics
MVP uses audit logs as the primary telemetry source. Production hardening includes a metrics exporter (Prometheus/OpenTelemetry) and SLO dashboards.

### 10.3 Alerting
Webhook alerts via `ALERT_WEBHOOK_URL` are triggered in the control loop.

### 10.4 Health Checks
`GET /health` returns `{ status: "ok" }`.

---

## 11. Deployment and Infrastructure

### 11.1 Runtime
- Node.js LTS (current toolchain is TypeScript/ES modules)
- Single-instance MVP deployment with file-based state
- Dockerfile and docker-compose supported

### 11.2 Environment Variables (selected)
From `.env.example`:
```bash
PORT=8000
HOST=0.0.0.0
DERIBIT_ENV=testnet
DERIBIT_PAPER=true
ALLOW_DERIBIT_PRIVATE_MTM=false
QUOTE_CACHE_TTL_MS=4000
QUOTE_CACHE_STALE_MS=20000
QUOTE_CACHE_HARD_MS=120000
AUDIT_LOG_PATH=./logs/audit.log
RISK_CONTROLS_PATH=./configs/risk_controls.json
```
Additional runtime env used in code:
- `LOOP_INTERVAL_MS`, `MTM_INTERVAL_MS`, `APP_MODE`, `FOXIFY_APPROVED`, `ACCOUNTS_CONFIG_PATH`

Sensitive credential variables are provisioned by the Foxify deployment environment (secrets manager or equivalent) and are intentionally omitted here. Bybit pricing uses public endpoints unless authenticated execution is explicitly enabled.

### 11.3 Scaling Strategy
The API is designed to be stateless at the request boundary. Scaling to multiple instances requires an external database for coverages, audit logs, and hedge ledger persistence.

### 11.4 Disaster Recovery
For MVP, recovery is achieved by reloading file-based snapshots. Production hardening should include scheduled backups and replication of audit logs.

---

## 12. Testing and QA

### 12.1 Unit Tests
Primary coverage exists in the hedging engine:
- `services/hedging/tests/`

Run:
```bash
npm run test
```

### 12.2 Operational Readiness Scripts
The integration pack includes shell-based readiness scripts (require `jq`):
- `run_phase1_4_tests.sh`: Phase 1-4 smoke test. Validates `coverage_activated`, pass-through events, intermittent selection (live), and net exposure hedge actions.
- `run_intermittent_tests.sh`: Exercises intermittent hedging selection with optional exposures; inspects `intermittent_hedge_eval`, `hedge_action_skipped`, and `hedge_order` logs.
- `run_phase3_readiness.sh`: Audits MTM and coverage ratio health, highlights `close_blocked`, `mtm_credit`, `mtm_position`, and `demo_credit` events.
- `run_phase3_tests.sh`: Applies Phase 3 flags (shadow/live), runs readiness and intermittent tests, and restores config on exit.

These scripts are intended for demo or staging environments and use `/admin/reset` where applicable.

### 12.3 Integration and E2E Tests
Planned for production hardening. The current focus is deterministic unit tests for risk and pricing logic.

### 12.4 Manual QA
Paper mode allows safe validation of quote and execution flows without live trading.

---

## 13. Roadmap

### Phase 1 (MVP Integration)
- BTC-only protection with Deribit execution
- Audit logs, coverage reporting, and control loop
- UI widget integration in Foxify dashboard

### Phase 2 (Production Hardening)
- External database, auth policies, and rate limiting
- Metrics export and SLO monitoring
- Multi-tenant isolation and configuration management

### Phase 3 (Advanced Capabilities)
- Optional on-chain settlement hooks
- Expanded asset support beyond BTC
- Formalized compliance and governance tooling

---

## 14. Glossary and Error Codes

### Glossary
- **Coverage**: A protection policy identified by `coverageId` and `expiryIso`.
- **Drawdown Buffer**: `equityUsdc - drawdownLimitUsdc`.
- **Hedge Ledger**: Persisted net hedge positions in `logs/hedge-ledger.json`.
- **Coverage Ledger**: Append-only MTM attribution log in `logs/coverage-ledger.json`.
- **Coverage Ratio**: Ratio of coverage value to required protection, logged per position in `mtm_position`.
- **MTM Position**: Per-position MTM snapshot used to validate buffer and coverage ratio.

### Error Codes (Observed)
- `invalid_payload`
- `unsupported_asset`
- `invalid_leverage`
- `no_quote`
- `too_early`
- `blocked`
- `missing_drawdown_inputs`
- `drawdown_buffer_positive`

---

## 15. Disclosure and IP Protection
This document provides technical depth sufficient for architecture validation, integration planning, and operational assurance. Proprietary parameter values, scoring weights, and strategy heuristics are intentionally summarized rather than disclosed in full. Sensitive credential material is intentionally omitted. Detailed internal logic, calibration data, and secure configuration details can be provided under NDA in the Technical Appendix.

---

## 16. Technical Appendix (Optional under NDA)
The following materials are available in a confidential appendix under NDA:
- Pricing and scoring weights for option selection.
- Exact buffer targets and hysteresis thresholds by tier.
- Volatility regime calibration tables and safety multipliers.
- Execution routing heuristics and slippage tolerance parameters.
- Internal risk budget allocation logic and guardrails.

