# API Contract (MVP)

## GET /health
Returns service status.

## GET /risk/summary
Returns equity, drawdown limit, and drawdown buffer.

If `positionPnlUsdc` or `hedgeMtmUsdc` are omitted, the API will fetch MTM from Deribit positions.

Optional:
`maxMtmAgeMs` controls MTM freshness tolerance (default 15000ms).

## GET /deribit/instruments
Returns available option instruments from Deribit.

## GET /deribit/ticker
Returns ticker for a given instrument.

## POST /deribit/order
Places an order (paper by default, live when enabled).

## GET /deribit/positions
Returns open positions from Deribit.

## GET /risk/mtm
Returns MTM components computed from Deribit positions.

## GET /pricing/btc
Returns the Deribit BTC index price.

## GET /foxify/portfolio (external)
This endpoint is provided by Foxify (not this API). The widget expects this shape
so demo mode can mirror production without logic changes.

Response:
```
{
  "tierName": "Pro (Bronze)",
  "positions": [
    {
      "id": "pos_1",
      "asset": "BTC",
      "side": "long",
      "marginUsd": 1500,
      "leverage": 10,
      "entryPrice": 89350
    }
  ]
}
```

Notes:
- `marginUsd` is the user margin allocation for the position.
- `notional = marginUsd * leverage` is used for exposure sizing.
- `entryPrice` can be derived from the fill price when opening the perp.
  If not provided, the widget uses current spot as a fallback in demo mode.

## POST /put/quote
Request a fixed-price protective put quote aligned to FUNDED level rules.

Body:
```
{
  "spotPrice": 50000,
  "drawdownFloorPct": 0.2,
  "fixedPriceUsdc": 25,
  "expiryTag": "optional",
  "tierName": "Pro (Bronze)",
  "fundingUsdc": 2500,
  "maxSpreadPct": 0.02,
  "maxSlippagePct": 0.01,
  "minSize": 0.05,
  "positionSize": 0.5,
  "contractSize": 1,
  "leverage": 10
}
```

Response includes:
- `hedgeSize`
- `sizingMethod` ("notional" or "delta")
- `bufferTargetPct` (leverage-adjusted)
- `premiumUsdc`
- `status` may be present for internal-only risk throttles
- `markIv`
- `score` (internal option scoring signal)

## GET /risk/daily-summary
Returns internal risk budget counters (operators only).

## POST /audit/export
Writes a JSON payload to `logs/` and returns the filename.

## GET /audit/entries
Returns recent audit log entries.

Query:
- `limit` (default 200)

## GET /audit/summary
Returns audit summary for dashboards.

Query:
- `mode`: `exec` or `internal` (default `exec`)

## POST /hedge/roll
Evaluates rolling hedge decision and executes a hedge increase if needed.

## POST /put/auto-renew
Builds a new fixed-price protective put and executes the renewal.

Optional:
```
{
  "expiryIso": "2026-02-25T08:00:00Z",
  "renewWindowMinutes": 240
}
```

## POST /put/auto-renew/schedule
Minimal scheduler endpoint for auto-renew checks.

## POST /loop/tick
Single-step control loop: refresh risk, evaluate hedge/renew, execute, alert.

## GET /alerts
List recent alerts (expiry, renewal, hedge actions).
