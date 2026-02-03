# Audit Schema & Event Catalog

This document defines the audit log schema and the minimum event set required
for executive and internal audit views.

## Log Format
Each event is stored as one JSON line in `logs/audit.log`.

```json
{
  "ts": "2026-01-28T02:45:10.123Z",
  "event": "coverage_activated",
  "payload": {
    "tier": "Pro (Bronze)",
    "assets": ["BTC", "ETH"],
    "notionalUsdc": 25000,
    "floorUsdc": 2000,
    "expiryIso": "2026-01-29T02:45:10.123Z"
  }
}
```

## Executive View (Essential Only)
These events are required for external validation of coverage:

- `coverage_activated`
- `coverage_renewed`
- `hedge_action` (increase/decrease, instrument, size)
- `hedge_order` (order placed for hedge)
- `mtm_credit` (equity update includes hedge MTM)
- `mtm_position` (per-position MTM credit)
- `demo_credit` (simulated margin credit in demo mode)
- `option_payout` (option settlement or payout)
- `coverage_expired`

## Internal View (Operator)
Internal view includes all executive events plus:

- `put_quote` (quote parameters)
- `risk_budget_update` (budget usage, caps, throttle)
- `liquidity_update` (liquidity balances and allocations)
- `execution_quality` (spread, slippage, price)
- `renewal_decision` (why/when renewal triggered)

## Event Definitions

### coverage_activated
Triggered when protection is activated.
```json
{
  "tier": "Pro (Bronze)",
  "assets": ["BTC"],
  "notionalUsdc": 25000,
  "floorUsdc": 2000,
  "expiryIso": "2026-01-29T02:45:10.123Z"
}
```

### coverage_renewed
Triggered when auto-renew executes successfully.
```json
{
  "tier": "Pro (Bronze)",
  "expiryIso": "2026-01-30T02:45:10.123Z",
  "instrument": "BTC-29JAN26-82000-P"
}
```

### hedge_action
Hedge decision from rolling logic.
```json
{
  "action": "increase",
  "reason": "buffer_below_target",
  "instrument": "BTC-PERPETUAL",
  "size": 0.5
}
```

### hedge_order
Order placed for a hedge action.
```json
{
  "instrument": "BTC-PERPETUAL",
  "side": "buy",
  "amount": 0.5,
  "type": "market"
}
```

### mtm_credit
Equity snapshot showing hedge MTM inclusion.
```json
{
  "equityUsdc": 9750.21,
  "positionPnlUsdc": -220.5,
  "hedgeMtmUsdc": 315.0
}
```

### mtm_position
Per-position MTM snapshot for drawdown buffer verification.
```json
{
  "coverageId": "cov_abc",
  "positionId": "pos_1",
  "positionPnlUsdc": -120.5,
  "hedgeMtmUsdc": 220.1,
  "equityUsdc": 9800.25,
  "drawdownBufferUsdc": 150.75,
  "coverageRatio": "1.0200"
}
```

### demo_credit
Simulated margin credit issued on drawdown breach (demo-only).
```json
{
  "coverageId": "cov_abc",
  "positionId": "pos_1",
  "creditUsdc": "85.50",
  "bufferUsdc": "-85.50"
}
```

### option_payout
Option settlement or payout (if available).
```json
{
  "instrument": "BTC-29JAN26-82000-P",
  "payoutUsdc": 310.5
}
```

### liquidity_update
Internal liquidity movement.
```json
{
  "liquidityBalanceUsdc": 20000,
  "hedgeSpendUsdc": 125.5,
  "revenueUsdc": 35,
  "profitUsdc": -90.5,
  "reinvestUsdc": 0,
  "reserveUsdc": 0
}
```

## Notes
- Executive view is intentionally minimal and does not show platform profit.
- Internal view includes revenue, hedge spend, and liquidity allocations.
