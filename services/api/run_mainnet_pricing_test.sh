#!/bin/bash
set -euo pipefail

echo "════════════════════════════════════════════════════════════"
echo "TEST 1: Silver Tier Short Position (Call Protection)"
echo "════════════════════════════════════════════════════════════"
echo ""

START_TIME=$(date +%s)

RESPONSE=$(curl -s -X POST http://localhost:4100/put/quote \
  -H "Content-Type: application/json" \
  -d '{
    "side": "short",
    "tierName": "Pro (Silver)",
    "asset": "BTC",
    "spotPrice": 100000,
    "fixedPriceUsdc": 100,
    "positionSize": 1.0,
    "leverage": 5,
    "drawdownFloorPct": 0.20,
    "targetDays": 7,
    "allowPremiumPassThrough": true
  }')

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo "Response time: ${ELAPSED} seconds"
echo ""
echo "Key Results:"
echo "────────────────────────────────────────────────────────────"
echo "$RESPONSE" | jq '{
  status,
  premiumUsdc,
  optionVenue,
  deribitPrice: .venueComparison.prices.deribit,
  bybitPrice: .venueComparison.prices.bybit,
  savingsUsdc: .venueComparison.savingsUsdc
}'

echo ""
echo "════════════════════════════════════════════════════════════"
echo ""

echo "════════════════════════════════════════════════════════════"
echo "TEST 2: Gold Tier Short Position (Higher Leverage)"
echo "════════════════════════════════════════════════════════════"
echo ""

START_TIME=$(date +%s)

RESPONSE=$(curl -s -X POST http://localhost:4100/put/quote \
  -H "Content-Type: application/json" \
  -d '{
    "side": "short",
    "tierName": "Pro (Gold)",
    "asset": "BTC",
    "spotPrice": 100000,
    "fixedPriceUsdc": 100,
    "positionSize": 1.0,
    "leverage": 10,
    "drawdownFloorPct": 0.25,
    "targetDays": 10,
    "allowPremiumPassThrough": true
  }')

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo "Response time: ${ELAPSED} seconds"
echo ""
echo "Key Results:"
echo "────────────────────────────────────────────────────────────"
echo "$RESPONSE" | jq '{
  status,
  premiumUsdc,
  optionVenue,
  deribitPrice: .venueComparison.prices.deribit,
  bybitPrice: .venueComparison.prices.bybit,
  savingsUsdc: .venueComparison.savingsUsdc
}'

echo ""
echo "════════════════════════════════════════════════════════════"
echo ""
