#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
PORT="${PORT:-4100}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-25}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install with: brew install jq (mac) or apt-get install jq (linux)"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required. Please install curl."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "node_modules not found. Installing dependencies..."
  npm install
fi

cleanup() {
  if [ -n "${API_PID:-}" ] && kill -0 "${API_PID}" >/dev/null 2>&1; then
    kill "${API_PID}" || true
  fi
}
trap cleanup EXIT

echo "Starting API (demo mode)..."
APP_MODE=demo \
LOOP_INTERVAL_MS=0 \
MTM_INTERVAL_MS=0 \
DERIBIT_ENV=testnet \
DERIBIT_PAPER=true \
PORT="${PORT}" \
npx tsx services/api/src/server.ts >/tmp/atticus_api.log 2>&1 &
API_PID=$!

echo "Waiting for /health..."
for _ in $(seq 1 "${STARTUP_TIMEOUT_SECONDS}"); do
  if curl -s "${API_BASE}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -s "${API_BASE}/health" >/dev/null 2>&1; then
  echo "API did not become healthy within ${STARTUP_TIMEOUT_SECONDS}s."
  echo "Last 200 lines of API log:"
  tail -n 200 /tmp/atticus_api.log || true
  exit 1
fi

echo "✅ /health"
curl -s "${API_BASE}/health" | jq

echo "✅ /integration/handshake"
curl -s "${API_BASE}/integration/handshake" | jq

echo "✅ /pricing/btc"
curl -s "${API_BASE}/pricing/btc" | jq

echo "✅ /pricing/iv/BTC"
curl -s "${API_BASE}/pricing/iv/BTC" | jq

echo "✅ /put/quote (Bronze)"
curl -s "${API_BASE}/put/quote" \
  -H "Content-Type: application/json" \
  -d '{
    "tierName":"Pro (Bronze)",
    "asset":"BTC",
    "spotPrice":100000,
    "drawdownFloorPct":0.2,
    "positionSize":0.05,
    "fixedPriceUsdc":10,
    "contractSize":1,
    "leverage":2,
    "side":"long",
    "coverageId":"smoke-001",
    "targetDays":7,
    "allowPremiumPassThrough":true
  }' | jq

echo "✅ /loop/tick (single cycle)"
curl -s "${API_BASE}/loop/tick" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId":"demo",
    "drawdownLimitUsdc":"9000",
    "initialBalanceUsdc":"10000",
    "hedgeInstrument":"BTC-29MAR24-50000-P",
    "hedgeSize":0.1,
    "bufferTargetPct":0.05,
    "hysteresisPct":0.02,
    "expiryIso":"2026-02-25T08:00:00Z",
    "renewWindowMinutes":1440,
    "renewPayload":{},
    "coverageId":"smoke-001",
    "autoRenew":false,
    "notionalUsdc":5000,
    "tierName":"Pro (Bronze)"
  }' | jq

echo "✅ /audit/logs"
curl -s "${API_BASE}/audit/logs?limit=20&showAll=true" | jq

echo "✅ /audit/summary (internal)"
curl -s "${API_BASE}/audit/summary?mode=internal" | jq

echo "Smoke test complete."
