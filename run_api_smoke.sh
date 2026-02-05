#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
PORT="${PORT:-4100}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-25}"
RISK_CONTROLS_PATH="${RISK_CONTROLS_PATH:-./configs/risk_controls.json}"
RISK_CONTROLS_BACKUP="${RISK_CONTROLS_BACKUP:-/tmp/risk_controls_smoke_backup.json}"
STALE_MTM_AGE_MS="${STALE_MTM_AGE_MS:-1000}"
NET_EXPOSURE_MIN_BUDGET_USDC="${NET_EXPOSURE_MIN_BUDGET_USDC:-999999}"

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
  if [ -f "${RISK_CONTROLS_BACKUP}" ]; then
    cp "${RISK_CONTROLS_BACKUP}" "${RISK_CONTROLS_PATH}" || true
  fi
}
trap cleanup EXIT

if [ -f "${RISK_CONTROLS_PATH}" ]; then
  cp "${RISK_CONTROLS_PATH}" "${RISK_CONTROLS_BACKUP}"
  tmp_file="$(mktemp)"
  jq \
    --argjson maxAge "${STALE_MTM_AGE_MS}" \
    --argjson minBudget "${NET_EXPOSURE_MIN_BUDGET_USDC}" \
    '.
    | .loop_use_mtm_buffer = true
    | .loop_block_on_stale_mtm = true
    | .loop_mtm_max_age_ms = $maxAge
    | .loop_stale_mtm_cooldown_ms = $maxAge
    | .net_exposure_budget_guard_enabled = true
    | .net_exposure_min_budget_usdc = $minBudget
    | .net_exposure_force_coverage_id = true
    ' "${RISK_CONTROLS_PATH}" > "${tmp_file}"
  mv "${tmp_file}" "${RISK_CONTROLS_PATH}"
  echo "Applied smoke-test risk control overrides."
else
  echo "Risk controls not found at ${RISK_CONTROLS_PATH} (skipping overrides)."
fi

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

echo "✅ /risk/summary (prime MTM snapshot)"
curl -s "${API_BASE}/risk/summary?drawdownLimitUsdc=9000&initialBalanceUsdc=10000&cashUsdc=10000&positionPnlUsdc=10&hedgeMtmUsdc=0" | jq
sleep 2

echo "✅ /loop/tick (single cycle)"
curl -s "${API_BASE}/loop/tick" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId":"demo",
    "drawdownLimitUsdc":"9000",
    "initialBalanceUsdc":"10000",
    "hedgeInstrument":"BTC-29MAR24-50000-P",
    "hedgeSize":0.1,
    "bufferTargetPct":0.2,
    "hysteresisPct":0.02,
    "expiryIso":"2026-02-25T08:00:00Z",
    "renewWindowMinutes":1440,
    "renewPayload":{},
    "coverageId":"smoke-mtm",
    "autoRenew":false,
    "notionalUsdc":5000,
    "tierName":"Pro (Bronze)",
    "exposures":[{
      "asset":"BTC",
      "side":"long",
      "entryPrice":100000,
      "size":0.05,
      "leverage":1
    }]
  }' | jq

echo "✅ /audit/logs"
curl -s "${API_BASE}/audit/logs?limit=20&showAll=true" | jq

echo "✅ MTM stale blocking check"
mtm_stale_count="$(curl -s "${API_BASE}/audit/logs?limit=50&showAll=true" | jq '[.entries[] | select(.event=="hedge_action_skipped") | select(.payload.reason=="mtm_stale")] | length')"
if [ "${mtm_stale_count}" -eq 0 ]; then
  echo "❌ Expected mtm_stale hedge_action_skipped not found."
  exit 1
fi
echo "✅ mtm_stale hedge_action_skipped: ${mtm_stale_count}"

echo "✅ Net exposure budget guard check"
budget_guard_count="$(curl -s "${API_BASE}/audit/logs?limit=50&showAll=true" | jq '[.entries[] | select(.event=="hedge_action_skipped") | select(.payload.reason=="budget_guard")] | length')"
if [ "${budget_guard_count}" -eq 0 ]; then
  echo "❌ Expected budget_guard hedge_action_skipped not found."
  exit 1
fi
echo "✅ budget_guard hedge_action_skipped: ${budget_guard_count}"

echo "✅ /audit/summary (internal)"
curl -s "${API_BASE}/audit/summary?mode=internal" | jq

echo "Smoke test complete."
