#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
CONFIG_PATH="${CONFIG_PATH:-./configs/risk_controls.json}"
TEST_COVERAGE_ID="${TEST_COVERAGE_ID:-test-phase-check}"
RESET_LOGS="${RESET_LOGS:-true}"
FORCE_INCREASE="${FORCE_INCREASE:-true}"
BUFFER_TARGET_PCT="${BUFFER_TARGET_PCT:-0.05}"
HYSTERESIS_PCT="${HYSTERESIS_PCT:-0.02}"
POSITION_SIZE="${POSITION_SIZE:-0.033}"
LOG_LIMIT="${LOG_LIMIT:-200}"
POST_LOG_DELAY_SECONDS="${POST_LOG_DELAY_SECONDS:-2}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install with: brew install jq (mac) or apt-get install jq (linux)"
  exit 1
fi

if [ ! -f "${CONFIG_PATH}" ]; then
  echo "Config file not found at ${CONFIG_PATH}"
  exit 1
fi

echo "=== Phase 1-4 Smoke Test ==="
echo "API_BASE=${API_BASE}"
echo "CONFIG_PATH=${CONFIG_PATH}"
echo "TEST_COVERAGE_ID=${TEST_COVERAGE_ID}"
echo "RESET_LOGS=${RESET_LOGS}"
echo

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

if [ "${RESET_LOGS}" = "true" ]; then
  echo "Step 1: Reset (demo mode only)"
  reset_file="$(mktemp)"
  reset_code="$(curl -s -o "${reset_file}" -w "%{http_code}" -X POST "${API_BASE}/admin/reset" || true)"
  echo "Status: ${reset_code}"
  cat "${reset_file}" | jq || cat "${reset_file}"
  rm -f "${reset_file}"
  echo
fi

start_epoch="$(date -u +%s)"

echo "Step 2: Fetch spot (Deribit index)"
spot="$(curl -s "https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd" | jq -r '.result.index_price')"
if [ -z "${spot}" ] || [ "${spot}" = "null" ]; then
  echo "Unable to fetch spot price."
  exit 1
fi
echo "Spot: ${spot}"
echo

echo "Step 3: Request quote (Phase 2 trigger)"
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
    \"coverageId\":\"${TEST_COVERAGE_ID}\",
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

if [ "${FORCE_INCREASE}" = "true" ]; then
  BUFFER_TARGET_PCT="0.30"
  echo "Force increase enabled: bufferTargetPct=${BUFFER_TARGET_PCT}"
  echo
fi

echo "Step 4: Seed coverage ledger (Phase 1 trigger)"
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
    \"coverageId\":\"${TEST_COVERAGE_ID}\",
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

echo "Step 5: Trigger loop/tick (Phase 3 + Phase 4)"
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
    \"coverageId\":\"${TEST_COVERAGE_ID}\",
    \"autoRenew\":true,
    \"notionalUsdc\":2500,
    \"hedgeType\":\"option\",
    \"tierName\":\"Pro (Bronze)\",
    \"skipNetExposure\":false,
    \"exposures\":[{
      \"asset\":\"BTC\",
      \"side\":\"long\",
      \"entryPrice\":${spot},
      \"size\":${POSITION_SIZE},
      \"leverage\":1
    }]
  }" | jq
echo

echo "Waiting ${POST_LOG_DELAY_SECONDS}s for logs to flush..."
sleep "${POST_LOG_DELAY_SECONDS}"
echo

logs="$(curl -s "${API_BASE}/audit/logs?limit=${LOG_LIMIT}&showAll=true")"
phase1_count="$(echo "${logs}" | jq --arg cid "${TEST_COVERAGE_ID}" --argjson since "${start_epoch}" '
  def ts_epoch: (.ts | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601);
  [.entries[] | select(.ts != null) | select(ts_epoch >= $since) | select(.event=="coverage_activated") | select((.payload.coverageId // "") == $cid)] | length')"
phase2_count="$(echo "${logs}" | jq --argjson since "${start_epoch}" '
  def ts_epoch: (.ts | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601);
  [.entries[] | select(.ts != null) | select(ts_epoch >= $since) | select(.event=="pass_through_gate" or .event=="premium_pass_through")] | length')"
phase3_count="$(echo "${logs}" | jq --arg cid "${TEST_COVERAGE_ID}" --argjson since "${start_epoch}" '
  def ts_epoch: (.ts | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601);
  [.entries[] | select(.ts != null) | select(ts_epoch >= $since) | select(.event=="intermittent_hedge_eval") | select((.payload.coverageId // "") == $cid) | select(.payload.selectionMode=="live")] | length')"
phase4_count="$(echo "${logs}" | jq --argjson since "${start_epoch}" '
  def ts_epoch: (.ts | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601);
  [.entries[] | select(.ts != null) | select(ts_epoch >= $since) | select(.event=="hedge_action") | select(.payload.action=="net_exposure" or .payload.reason=="net_exposure_hedge")] | length')"

echo "Phase checks (events since test start):"
if [ "${phase1_count}" -gt 0 ]; then
  echo "  ✅ Phase 1: coverage_activated (${phase1_count})"
else
  echo "  ❌ Phase 1: missing coverage_activated"
fi

if [ "${phase2_count}" -gt 0 ]; then
  echo "  ✅ Phase 2: pass_through_gate/premium_pass_through (${phase2_count})"
else
  echo "  ❌ Phase 2: missing pass_through_gate/premium_pass_through"
fi

if [ "${phase3_count}" -gt 0 ]; then
  echo "  ✅ Phase 3: intermittent_hedge_eval live (${phase3_count})"
else
  echo "  ❌ Phase 3: missing intermittent_hedge_eval live"
fi

if [ "${phase4_count}" -gt 0 ]; then
  echo "  ✅ Phase 4: hedge_action net_exposure (${phase4_count})"
else
  echo "  ❌ Phase 4: missing hedge_action net_exposure"
fi

echo
echo "Done."
