# Pilot API (Foxify Protection)

These endpoints are enabled when `PILOT_API_ENABLED=true`.

## Public pilot endpoints

- `POST /pilot/protections/quote`
- `POST /pilot/protections/activate`
- `GET /pilot/reference-price?marketId=BTC-USD`
- `GET /pilot/terms/status?termsVersion=<version>`
- `POST /pilot/terms/accept`
- `GET /pilot/protections?limit=<n>`
- `GET /pilot/protections/:id`
- `GET /pilot/protections/:id/monitor`
- `GET /pilot/protections/:id/proof` (requires `x-proof-token` or `Authorization: Bearer <token>`)
- `POST /pilot/protections/:id/renewal-decision`

## Internal/admin endpoints

Requires:

- `x-admin-token` header matching `PILOT_ADMIN_TOKEN`
- if `PILOT_ADMIN_IP_ALLOWLIST` is configured (non-empty), request IP must be in allowlist

Endpoints:

- `POST /pilot/admin/protections/:id/premium-settled`
- `POST /pilot/admin/protections/:id/payout-settled`
- `GET /pilot/admin/protections/:id/ledger`
- `GET /pilot/admin/metrics` (includes reserve/liquidity rollups using `PILOT_STARTING_RESERVE_USDC`)
- `GET /pilot/protections/export?format=json|csv&limit=<n>&offset=<n>` (tenant-scoped admin export)
- `GET /pilot/admin/reconciliation/export?format=json|csv&limit=<n>&offset=<n>`
- `POST /pilot/internal/protections/:id/resolve-expiry` (internal operations/testing)

## Price source chain

1. Canonical primary reference endpoint (`PRICE_REFERENCE_URL`)
2. Market id pinned by config (`PRICE_REFERENCE_MARKET_ID`, default `BTC-USD`)
3. Optional fallback endpoint (`FALLBACK_PRICE_URL`) only when `PRICE_SINGLE_SOURCE=false`
4. Reference fetches automatically retry transient payload/network errors:
   - `PRICE_REQUEST_RETRY_ATTEMPTS` (default `3`)
   - `PRICE_REQUEST_RETRY_DELAY_MS` (default `180`)
5. If reference resolution fails or payload is invalid, response is:
   - `status=error`
   - `reason=price_unavailable`
   - message: `Price temporarily unavailable, please retry.`
6. If storage is unavailable, response may be:
   - `status=error`
   - `reason=storage_unavailable`
   - message: `Storage temporarily unavailable, please retry.`
7. If venue quote generation fails, response may be:
   - `status=error`
   - `reason=quote_generation_failed`
   - message: `Unable to generate a venue quote right now. Please retry.`
8. `GET /pilot/reference-price` exposes the current server-side reference anchor (price, venue, source, timestamp)
   used to calibrate protection economics.

## Ledger entries

The pilot ledger stores:

- `premium_due`
- `premium_settled`
- `payout_due`
- `payout_settled`

Settlement posting endpoints are idempotent per protection + entry type for pilot operations. Repeated
settlement calls for an already-settled protection return `status=ok` with `idempotentReplay=true`.
Expiry and settlement writes are protected by deterministic per-protection write keys to keep one-time
accounting behavior under concurrent requests.

## Admin scope and exports

- Admin metrics and export endpoints are tenant/campaign scoped using the configured pilot tenant scope hash.
- `GET /pilot/protections/export?format=json` returns:
  - `rows`
  - `pagination` (`total`, `limit`, `offset`, `nextOffset`)
- `GET /pilot/admin/reconciliation/export` provides reconciliation-friendly rows including:
  - trade/execution identifiers (quote/rfq/external order/execution)
  - premium and payout ledger totals
  - outstanding receivable/liability deltas
  - settlement references.

## Tier and trigger semantics

- Pilot quote/activate accepts `tierName` and optional `drawdownFloorPct`.
- Pilot quote/activate accepts `protectionType`:
  - `long` (default): downside protection via put semantics
  - `short`: upside protection via call semantics
- If `drawdownFloorPct` is omitted, tier default drawdown is used:
  - Bronze: 20%
  - Silver: 15%
  - Gold: 12%
  - Platinum: 12%
- Trigger price is calculated as:
  - `long`: `trigger_price = server_entry_anchor_price * (1 - drawdown_floor_pct)` (floor)
  - `short`: `trigger_price = server_entry_anchor_price * (1 + drawdown_floor_pct)` (ceiling)
- `server_entry_anchor_price` is captured from the canonical live reference snapshot at quote lock / activation.
- Optional client `entryPrice` is informational only and not used to determine trigger or payout economics.
- `protection.entryPriceSource` is expected to be `reference_snapshot_quote` for pilot quote-lock activations.
- Payout due logic at expiry:
  - `long`: `payout_due = max(trigger_price - expiry_price, 0) / server_entry_anchor_price * protected_notional`
  - `short`: `payout_due = max(expiry_price - trigger_price, 0) / server_entry_anchor_price * protected_notional`

## Pilot constraints

- Tenor is fixed at 7 days by tier defaults for pilot.
- `protectedNotional` must be `<= 50,000` USDC per protection.
- Daily protected notional cap is `50,000` USDC for the pilot tenant scope and is enforced on activation.
- Daily cap reset boundary is `00:00 UTC` (calendar-day reset, not rolling 24h).
- Quote responses may still be returned when the projected daily cap is exceeded, with limit telemetry included.
- Terms acceptance is stored once per pilot tenant scope and terms version (`PILOT_TERMS_VERSION`, default `v1.0`) with server-side audit fields (accepted timestamp, client IP, user-agent).
- Pilot premium supports passthrough + markup with tier floors:
  - `client_premium = max(hedge_premium + hedge_premium * tier_markup_pct, tier_floor_usd, protected_notional * tier_floor_bps / 10000)`
  - tier markup defaults:
    - Bronze: `PILOT_PREMIUM_MARKUP_PCT_BRONZE` (`0.06`)
    - Silver: `PILOT_PREMIUM_MARKUP_PCT_SILVER` (`0.05`)
    - Gold: `PILOT_PREMIUM_MARKUP_PCT_GOLD` (`0.04`)
    - Platinum: `PILOT_PREMIUM_MARKUP_PCT_PLATINUM` (`0.03`)
  - tier USD floor defaults:
    - Bronze: `PILOT_PREMIUM_FLOOR_USD_BRONZE` (`20`)
    - Silver: `PILOT_PREMIUM_FLOOR_USD_SILVER` (`17`)
    - Gold: `PILOT_PREMIUM_FLOOR_USD_GOLD` (`14`)
    - Platinum: `PILOT_PREMIUM_FLOOR_USD_PLATINUM` (`12`)
  - tier bps safety floor defaults:
    - Bronze: `PILOT_PREMIUM_FLOOR_BPS_BRONZE` (`6`)
    - Silver: `PILOT_PREMIUM_FLOOR_BPS_SILVER` (`5`)
    - Gold: `PILOT_PREMIUM_FLOOR_BPS_GOLD` (`4`)
    - Platinum: `PILOT_PREMIUM_FLOOR_BPS_PLATINUM` (`4`)
- `entryPrice` is optional and treated as user-provided context only (informational).
- Activation must include a fresh `quoteId` from `/pilot/protections/quote`.
- Quote and activation require prior acceptance of current terms (`POST /pilot/terms/accept`),
  otherwise both endpoints return `403` with `reason=terms_not_accepted`.
- Optional campaign window enforcement for new quote/activate requests:
  - `PILOT_ENFORCE_WINDOW=true`
  - `PILOT_START_AT=<ISO-8601 UTC>`
  - `PILOT_DURATION_DAYS` (default `30`)
  - blocked reasons:
    - `pilot_not_started`
    - `pilot_window_closed`
- Venue quote/execute operations enforce bounded timeouts:
  - `PILOT_VENUE_QUOTE_TIMEOUT_MS` (default 10000ms)
  - `PILOT_QUOTE_TTL_MS` (default 30000ms lock window for mock/deribit_test pilot quotes)
  - `PILOT_VENUE_EXEC_TIMEOUT_MS` (default 8000ms)
  - `PILOT_VENUE_MARK_TIMEOUT_MS` (default 3000ms)
- When `PILOT_FORCE_DERIBIT_TEST_MODE=true` (default), pilot runtime forces Deribit test-only mode:
  - `DERIBIT_ENV=testnet`
  - `DERIBIT_PAPER=true`
- Deribit quote behavior can be toggled without code changes:
  - `PILOT_DERIBIT_QUOTE_POLICY=ask_or_mark_fallback` (default, allows mark fallback when ask is empty)
  - `PILOT_DERIBIT_QUOTE_POLICY=ask_only` (strict top-of-book ask only)
  - `PILOT_STRIKE_SELECTION_MODE=legacy` (default 85%/115% heuristic)
  - `PILOT_STRIKE_SELECTION_MODE=trigger_aligned` (selects strikes nearest computed trigger price)
- Quote, activation, and expiry resolution all use the same canonical reference feed configuration.
- Venue mode is controlled by `PILOT_VENUE_MODE`:
  - `deribit_test` (default for pilot realism + safeguards)
  - `falconx` (live FalconX credentials)
  - `mock_falconx` (offline mock path)
- Venue adapters are isolated behind `PilotVenueAdapter` so additional exchanges (for example Bullish) can
  be added without changing pilot route contracts.

## Proof payload policy

- Proof response is authenticated and intentionally minimal:
  - protection status, floor/drawdown, entry/expiry price snapshots, and hedge execution references.
- Proof excludes internal economics fields (platform PnL, margins, and ledger economics).

