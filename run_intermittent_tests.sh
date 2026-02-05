#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
CONFIG_PATH="${CONFIG_PATH:-./configs/risk_controls.json}"
INCLUDE_EXPOSURES="${INCLUDE_EXPOSURES:-false}"
FORCE_INCREASE="${FORCE_INCREASE:-false}"
BUFFER_TARGET_PCT="${BUFFER_TARGET_PCT:-0.05}"
HYSTERESIS_PCT="${HYSTERESIS_PCT:-0.02}"
POSITION_SIZE="${POSITION_SIZE:-0.033}"
LOOPS="${LOOPS:-1}"
SLEEP_SECONDS="${SLEEP_SECONDS:-2}"
LOG_LIMIT="${LOG_LIMIT:-200}"
POST_LOG_DELAY_SECONDS="${POST_LOG_DELAY_SECONDS:-2}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install with: brew install jq (mac) or apt-get install jq (linux)"
  exit 1
fi

echo "=== Intermittent Hedging Test Script ==="
echo "API_BASE=${API_BASE}"
echo "CONFIG_PATH=${CONFIG_PATH}"
echo "INCLUDE_EXPOSURES=${INCLUDE_EXPOSURES}"
echo "FORCE_INCREASE=${FORCE_INCREASE}"
echo "BUFFER_TARGET_PCT=${BUFFER_TARGET_PCT}"
echo "POSITION_SIZE=${POSITION_SIZE}"
echo "LOOPS=${LOOPS}"
echo "SLEEP_SECONDS=${SLEEP_SECONDS}"
echo "LOG_LIMIT=${LOG_LIMIT}"
echo "POST_LOG_DELAY_SECONDS=${POST_LOG_DELAY_SECONDS}"
echo

if [ -f "${CONFIG_PATH}" ]; then
  echo "Flags (from ${CONFIG_PATH}):"
  jq -r '{
    phase3_rollout_enabled,
    phase3_safety_guard_enabled,
    intermittent_analytics_enabled,
    intermittent_selection_shadow_enabled,
    intermittent_selection_live_enabled,
    intermittent_selection_size_tolerance_pct,
    intermittent_profit_threshold_enabled,
    intermittent_profit_min_improvement_usdc,
    intermittent_profit_min_improvement_ratio,
    intermittent_profit_critical_buffer_pct
  }' "${CONFIG_PATH}"
  echo
else
  echo "Config file not found at ${CONFIG_PATH} (skipping flag output)."
  echo
fi

echo "Step 1: API reachability"
resp_file="$(mktemp)"
http_code="$(curl -s -o "${resp_file}" -w "%{http_code}" "${API_BASE}/audit/summary?mode=internal" || true)"
if [ "${http_code}" != "200" ]; then
  echo "API not reachable or /audit/summary failed (status ${http_code})."
  cat "${resp_file}"
  rm -f "${resp_file}"
  exit 1
fi
echo "OK"
rm -f "${resp_file}"
echo

echo "Step 2: Reset (demo mode only)"
reset_file="$(mktemp)"
reset_code="$(curl -s -o "${reset_file}" -w "%{http_code}" -X POST "${API_BASE}/admin/reset" || true)"
echo "Status: ${reset_code}"
cat "${reset_file}" | jq || cat "${reset_file}"
rm -f "${reset_file}"
echo

echo "Step 3: Summary after reset"
curl -s "${API_BASE}/audit/summary?mode=internal" | jq
echo

echo "Step 4: Fetch spot (Deribit index)"
spot="$(curl -s "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd" | jq -r '.result.index_price')"
if [ -z "${spot}" ] || [ "${spot}" = "null" ]; then
  echo "Unable to fetch spot price."
  exit 1
fi
echo "Spot: ${spot}"
echo

echo "Step 5: Request quote"
quote="$(curl -s "${API_BASE}/put/quote" \
  -H "Content-Type: application/json" \
  -d "{
    \"tierName\":\"Pro (Bronze)\",
    \"asset\":\"BTC\",
    \"spotPrice\":${spot},
    \"drawdownFloorPct\":0.2,
    \"positionSize\":${POSITION_SIZE},
    \"fixedPriceUsdc\":10,
    \"contractSize\":1,
    \"leverage\":1,
    \"side\":\"long\",
    \"coverageId\":\"test-intermittent\",
    \"targetDays\":7,
    \"allowPremiumPassThrough\":true
  }")"
echo "${quote}" | jq
instrument="$(echo "${quote}" | jq -r '.instrument // empty')"
hedge_size="$(echo "${quote}" | jq -r '.hedgeSize // empty')"
strike_value="$(echo "${quote}" | jq -r '.strike // empty')"
if [ -z "${instrument}" ] || [ -z "${hedge_size}" ]; then
  echo "Quote missing instrument/hedgeSize; cannot proceed."
  exit 1
fi
echo

expiry_iso="$(python3 - <<'PY'
from datetime import datetime, timedelta
print((datetime.utcnow() + timedelta(days=7)).isoformat(timespec="seconds") + "Z")
PY
)"

margin_usd="$(python3 - <<PY
spot = float("${spot}")
pos = float("${POSITION_SIZE}")
print(round(spot * pos, 2))
PY
)"

exposures_payload="[]"
if [ "${INCLUDE_EXPOSURES}" = "true" ]; then
  exposures_payload="[{\"asset\":\"BTC\",\"side\":\"long\",\"entryPrice\":${spot},\"size\":${POSITION_SIZE},\"leverage\":1}]"
fi

if [ "${FORCE_INCREASE}" = "true" ]; then
  BUFFER_TARGET_PCT="0.30"
  echo "Force increase enabled: bufferTargetPct=${BUFFER_TARGET_PCT}"
  echo
fi

echo "Step 5b: Seed coverage ledger via /audit/export"
now_iso="$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"))
PY
)"
strike_payload=""
if [ -n "${strike_value}" ]; then
  strike_payload=",\"strike\":${strike_value}"
fi
curl -s "${API_BASE}/audit/export" \
  -H "Content-Type: application/json" \
  -d "{
    \"ts\":\"${now_iso}\",
    \"tier\":\"Pro (Bronze)\",
    \"autoRenew\":true,
    \"feeUsd\":10,
    \"baseFeeUsd\":10,
    \"totalFeeUsd\":10,
    \"coverageId\":\"test-intermittent\",
    \"expiryIso\":\"${expiry_iso}\",
    \"selectedVenue\":\"bybit\",
    \"notionalUsdc\":2500,
    \"portfolio\":{
      \"tierName\":\"Pro (Bronze)\",
      \"positions\":[{
        \"id\":\"pos-test\",
        \"asset\":\"BTC\",
        \"side\":\"long\",
        \"marginUsd\":${margin_usd},
        \"leverage\":1,
        \"entryPrice\":${spot}
      }]
    },
    \"hedge\":{
      \"hedgeType\":\"option\",
      \"instrument\":\"${instrument}\",
      \"hedgeSize\":${hedge_size},
      \"optionType\":\"put\"${strike_payload},
      \"venue\":\"bybit\"
    }
  }" | jq
echo

for i in $(seq 1 "${LOOPS}"); do
  echo "Step 6.${i}: Trigger loop/tick"
  curl -s "${API_BASE}/loop/tick" \
    -H "Content-Type: application/json" \
    -d "{
      \"accountId\":\"demo\",
      \"drawdownLimitUsdc\":\"2000\",
      \"initialBalanceUsdc\":\"2500\",
      \"hedgeInstrument\":\"${instrument}\",
      \"hedgeSize\":${hedge_size},
      \"bufferTargetPct\":${BUFFER_TARGET_PCT},
      \"hysteresisPct\":${HYSTERESIS_PCT},
      \"expiryIso\":\"${expiry_iso}\",
      \"renewWindowMinutes\":1440,
      \"renewPayload\":{},
      \"coverageId\":\"test-intermittent\",
      \"autoRenew\":true,
      \"notionalUsdc\":2500,
      \"hedgeType\":\"option\",
      \"tierName\":\"Pro (Bronze)\",
      \"skipNetExposure\":true,
      \"exposures\":${exposures_payload}
    }" | jq
  if [ "${i}" -lt "${LOOPS}" ]; then
    echo "Sleeping ${SLEEP_SECONDS}s..."
    sleep "${SLEEP_SECONDS}"
  fi
  echo
done

echo "Waiting ${POST_LOG_DELAY_SECONDS}s for logs to flush..."
sleep "${POST_LOG_DELAY_SECONDS}"
echo

echo "Step 7: Recent intermittent analytics (if enabled)"
curl -s "${API_BASE}/audit/logs?limit=${LOG_LIMIT}&showAll=true" | \
  jq '.entries | map(select(.event=="intermittent_hedge_eval")) | .[0:5]'
echo

echo "Step 8: Recent hedge_action_skipped (profit threshold/cooldown)"
curl -s "${API_BASE}/audit/logs?limit=${LOG_LIMIT}&showAll=true" | \
  jq '.entries | map(select(.event=="hedge_action_skipped")) | .[0:5]'
echo

echo "Step 9: Recent hedge_order entries"
curl -s "${API_BASE}/audit/logs?limit=${LOG_LIMIT}&showAll=true" | \
  jq '.entries | map(select(.event=="hedge_order")) | .[0:5]'
echo

echo "Done."
