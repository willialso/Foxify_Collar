#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
TARGET_NOTIONALS_CSV="${TARGET_NOTIONALS_CSV:-1000,5000,10000,50000}"
LEVERAGES_CSV="${LEVERAGES_CSV:-1,2,5,10}"
TIERS_CSV="${TIERS_CSV:-Pro (Bronze),Pro (Silver),Pro (Gold),Pro (Platinum)}"
TARGET_DAYS="${TARGET_DAYS:-7}"
SIDE="${SIDE:-long}"
TENOR_TOLERANCE_DAYS="${TENOR_TOLERANCE_DAYS:-2}"
POLICY_MAX_FEE_TO_PREMIUM_RATIO="${POLICY_MAX_FEE_TO_PREMIUM_RATIO:-1.8}"
MAX_RECONCILIATION_ERROR_PCT="${MAX_RECONCILIATION_ERROR_PCT:-0.5}"
MAX_EXEC_FAILURE_RATE="${MAX_EXEC_FAILURE_RATE:-0.15}"
FEE_MAP_JSON="${FEE_MAP_JSON:-{\"Pro (Bronze)\":10,\"Pro (Silver)\":15,\"Pro (Gold)\":25,\"Pro (Platinum)\":35}}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1"
    exit 1
  fi
}

need_cmd curl
need_cmd jq
need_cmd python3

if ! curl -sf "${API_BASE}/health" >/dev/null 2>&1; then
  echo "API is not reachable at ${API_BASE}"
  exit 1
fi

spot="$(curl -s "${API_BASE}/pricing/btc" | jq -r '.result.index_price // empty')"
if [[ -z "${spot}" || "${spot}" == "null" ]]; then
  echo "Failed to fetch BTC spot price from ${API_BASE}/pricing/btc"
  exit 1
fi

fee_for_tier() {
  local tier="$1"
  local fee
  fee="$(jq -r --arg tier "${tier}" '.[$tier] // empty' <<<"${FEE_MAP_JSON}")"
  if [[ -z "${fee}" || "${fee}" == "null" ]]; then
    fee="10"
  fi
  echo "${fee}"
}

IFS=',' read -r -a TARGET_NOTIONALS <<< "${TARGET_NOTIONALS_CSV}"
IFS=',' read -r -a LEVERAGES <<< "${LEVERAGES_CSV}"
IFS=',' read -r -a TIERS <<< "${TIERS_CSV}"

quote_failures=0
checked_quotes=0
out_of_cohort_skips=0

echo "===================================================================="
echo "Pilot Acceptance Gates"
echo "API_BASE=${API_BASE}"
echo "Spot=${spot}"
echo "Target notional sweep=${TARGET_NOTIONALS_CSV}"
echo "Leverage sweep=${LEVERAGES_CSV}"
echo "Tier sweep=${TIERS_CSV}"
echo "Target days=${TARGET_DAYS} (tolerance ±${TENOR_TOLERANCE_DAYS}d)"
echo "Max fee/premium ratio=${POLICY_MAX_FEE_TO_PREMIUM_RATIO}"
echo "===================================================================="

for tier in "${TIERS[@]}"; do
  tier="$(echo "${tier}" | sed 's/^ *//; s/ *$//')"
  fixed_fee="$(fee_for_tier "${tier}")"
  for notional in "${TARGET_NOTIONALS[@]}"; do
    notional="$(echo "${notional}" | sed 's/^ *//; s/ *$//')"
    position_size="$(python3 - <<PY
spot = float("${spot}")
notional = float("${notional}")
print(notional / spot if spot > 0 else 0)
PY
)"
    for lev in "${LEVERAGES[@]}"; do
      lev="$(echo "${lev}" | sed 's/^ *//; s/ *$//')"
      payload="$(jq -n \
        --arg tier "${tier}" \
        --argjson spot "${spot}" \
        --argjson drawdown "0.20" \
        --argjson pos "${position_size}" \
        --argjson fee "${fixed_fee}" \
        --argjson lev "${lev}" \
        --arg side "${SIDE}" \
        --argjson days "${TARGET_DAYS}" \
        '{
          tierName: $tier,
          asset: "BTC",
          spotPrice: $spot,
          drawdownFloorPct: $drawdown,
          positionSize: $pos,
          fixedPriceUsdc: $fee,
          contractSize: 1,
          leverage: $lev,
          side: $side,
          coverageId: "pilot-acceptance",
          targetDays: $days,
          allowPremiumPassThrough: true
        }')"
      response="$(curl -s "${API_BASE}/put/quote" -H "Content-Type: application/json" -d "${payload}")"
      status="$(jq -r '.status // "unknown"' <<<"${response}")"
      reason="$(jq -r '.reason // empty' <<<"${response}")"
      fee="$(jq -r '.feeUsdc // empty' <<<"${response}")"
      premium="$(jq -r '.rollEstimatedPremiumUsdc // .premiumUsdc // empty' <<<"${response}")"
      selected_days="$(jq -r '.targetDays // empty' <<<"${response}")"
      tenor_reason="$(jq -r '.tenorReason // empty' <<<"${response}")"

      checked_quotes=$((checked_quotes + 1))

      if [[ "${status}" != "ok" && "${status}" != "pass_through" ]]; then
        if [[ "${reason}" == "tier_notional_min" ]]; then
          min_notional="$(jq -r '.minNotionalUsdc // empty' <<<"${response}")"
          out_of_cohort_skips=$((out_of_cohort_skips + 1))
          echo "SKIP out-of-cohort tier=${tier} notional=${notional} lev=${lev}: minNotional=${min_notional}"
          continue
        fi
        echo "FAIL quote status tier=${tier} notional=${notional} lev=${lev}: status=${status}"
        quote_failures=$((quote_failures + 1))
        continue
      fi

      ratio_ok="$(python3 - <<PY
import math
fee = float("${fee:-0}" or 0)
premium = float("${premium:-0}" or 0)
max_ratio = float("${POLICY_MAX_FEE_TO_PREMIUM_RATIO}")
if premium <= 0:
    print("skip")
else:
    ratio = fee / premium
    print("ok" if ratio <= max_ratio else f"fail:{ratio:.6f}")
PY
)"
      if [[ "${ratio_ok}" == fail:* ]]; then
        echo "FAIL fee/premium ratio tier=${tier} notional=${notional} lev=${lev}: ${ratio_ok#fail:} > ${POLICY_MAX_FEE_TO_PREMIUM_RATIO}"
        quote_failures=$((quote_failures + 1))
      fi

      drift_ok="$(python3 - <<PY
import math
requested = float("${TARGET_DAYS}")
selected = float("${selected_days:-0}" or 0)
tolerance = float("${TENOR_TOLERANCE_DAYS}")
drift = abs(selected - requested)
if drift <= tolerance:
    print("ok")
else:
    print("needs_fallback")
PY
)"
      if [[ "${drift_ok}" == "needs_fallback" && "${tenor_reason}" != "tenor_fallback" ]]; then
        echo "FAIL tenor attribution tier=${tier} notional=${notional} lev=${lev}: drift>${TENOR_TOLERANCE_DAYS} without tenor_fallback"
        quote_failures=$((quote_failures + 1))
      fi
    done
  done
done

echo
echo "Quote gate checks: ${checked_quotes} scenarios, failures=${quote_failures}"
echo "Out-of-cohort skips=${out_of_cohort_skips}"

recon_failures=0
coverage_json="$(curl -s "${API_BASE}/coverage/active?accountId=demo")"
coverage_count="$(jq -r '.count // 0' <<<"${coverage_json}")"
if [[ "${coverage_count}" != "0" ]]; then
  recon_failures="$(jq -r --argjson max_err "${MAX_RECONCILIATION_ERROR_PCT}" '
    [
      (.coverages // [])[]
      | select((.quotedFeeUsdc // null) != null and (.collectedFeeUsdc // null) != null and (.quotedFeeUsdc|tonumber) > 0)
      | (( ((.collectedFeeUsdc|tonumber) - (.quotedFeeUsdc|tonumber)) | if . < 0 then -. else . end ) / (.quotedFeeUsdc|tonumber) * 100) as $err
      | select($err > $max_err)
    ] | length
  ' <<<"${coverage_json}")"
else
  echo "Reconciliation check skipped (no active coverages)."
fi

exec_failures=0
audit_json="$(curl -s "${API_BASE}/audit/logs?limit=300&showAll=true")"
hedge_total="$(jq -r '[.entries[] | select(.event=="hedge_order")] | length' <<<"${audit_json}")"
if [[ "${hedge_total}" != "0" ]]; then
  hedge_fail="$(jq -r '[.entries[] | select(.event=="hedge_order") | select((.payload.status // "") | IN("paper_filled","filled","ok") | not)] | length' <<<"${audit_json}")"
  failure_rate="$(python3 - <<PY
total = float("${hedge_total}")
fail = float("${hedge_fail}")
print((fail / total) if total > 0 else 0.0)
PY
)"
  exceeds="$(python3 - <<PY
rate = float("${failure_rate}")
limit = float("${MAX_EXEC_FAILURE_RATE}")
print("1" if rate > limit else "0")
PY
)"
  if [[ "${exceeds}" == "1" ]]; then
    exec_failures=1
    echo "FAIL execution stability: failure rate=${failure_rate} > ${MAX_EXEC_FAILURE_RATE}"
  fi
else
  echo "Execution stability check skipped (no hedge_order samples)."
fi

total_failures=$((quote_failures + recon_failures + exec_failures))
echo "Reconciliation failures=${recon_failures}"
echo "Execution gate failures=${exec_failures}"
echo "Total gate failures=${total_failures}"

if [[ "${total_failures}" -gt 0 ]]; then
  exit 1
fi

echo "All pilot acceptance gates passed."
