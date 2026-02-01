# Atticus MVP API Reference

## GET /health
Returns service status.

Response:
```json
{
  "status": "ok",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "deribitEnv": "testnet",
  "ivLadderReady": true
}
```

## POST /pricing/ctc
Returns a coverage quote with CTC pricing if available.

Request:
```json
{
  "tierName": "Pro (Bronze)",
  "asset": "BTC",
  "spotPrice": 100000,
  "drawdownFloorPct": 0.12,
  "positionSize": 0.5,
  "leverage": 5,
  "targetDays": 7
}
```

Response:
```json
{
  "status": "ok",
  "tierName": "Pro (Bronze)",
  "feeUsdc": "42.00",
  "ctcUsed": true,
  "ctcFeeUsdc": "42.00",
  "baseFeeUsdc": "30.00",
  "feeRegime": "normal",
  "feeRegimeMultiplier": "1.0000",
  "feeLeverageMultiplier": "1.0500",
  "markIv": 0.65,
  "baseIv": 0.6,
  "hedgeIv": 0.75,
  "targetDays": 7,
  "quoteLockExpiry": "2026-01-01T00:00:04.000Z"
}
```

## POST /coverage/activate
Executes coverage and returns execution trail.

Request:
```json
{
  "coverageId": "cov_001",
  "tierName": "Pro (Silver)",
  "asset": "BTC",
  "spotPrice": 100000,
  "drawdownFloorPct": 0.12,
  "positionSize": 0.5,
  "leverage": 5,
  "targetDays": 7,
  "expiryTag": "8FEB25",
  "feeUsdc": 45,
  "allowPerpFallback": true
}
```

Response:
```json
{
  "status": "success",
  "coverageId": "cov_001",
  "executionStatus": "partial",
  "instrument": "BTC-8FEB25-88000-P",
  "hedgeSize": "0.5000",
  "averageFillPrice": "0.016000",
  "premiumUsdc": "800.00",
  "feeUsdc": "45.00",
  "coverageRatio": "60.00",
  "profitMargin": "-755.00",
  "executionTimeMs": 520,
  "attempts": [],
  "liquidityDelta": {
    "liquidityBalanceUsdc": "120.00",
    "profitUsdc": "-755.00"
  }
}
```

## GET /audit/logs
Returns audit log entries.

Response:
```json
{
  "entries": [],
  "count": 0
}
```

## GET /risk/summary
Returns risk and liquidity summaries.

Response:
```json
{
  "risk": {},
  "liquidity": {
    "liquidityBalanceUsdc": "0.00",
    "hedgeSpendUsdc": "0.00",
    "revenueUsdc": "0.00",
    "profitUsdc": "0.00",
    "reinvestUsdc": "0.00",
    "reserveUsdc": "0.00"
  }
}
```

## GET /metrics
Returns operational metrics.

