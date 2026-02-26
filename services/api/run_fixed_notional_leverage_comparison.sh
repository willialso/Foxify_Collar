#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
TARGET_NOTIONAL_USDC="${TARGET_NOTIONAL_USDC:-50000}"
DRAWDOWN_FLOOR_PCT="${DRAWDOWN_FLOOR_PCT:-0.20}"
TARGET_DAYS="${TARGET_DAYS:-7}"
SIDE="${SIDE:-long}"
TIERS_CSV="${TIERS_CSV:-Pro (Bronze),Pro (Silver)}"
LEVERAGES_CSV="${LEVERAGES_CSV:-1,2,5,10}"
FEE_MAP_JSON="${FEE_MAP_JSON:-{\"Pro (Bronze)\":10,\"Pro (Silver)\":15,\"Pro (Gold)\":25,\"Pro (Platinum)\":35}}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install jq and retry."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required. Install python3 and retry."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required. Install curl and retry."
  exit 1
fi

if ! curl -sf "${API_BASE}/health" >/dev/null 2>&1; then
  echo "API is not reachable at ${API_BASE}. Start services/api first."
  exit 1
fi

spot="$(curl -s "${API_BASE}/pricing/btc" | jq -r '.result.index_price // empty')"
if [[ -z "${spot}" || "${spot}" == "null" ]]; then
  echo "Unable to fetch spot price from ${API_BASE}/pricing/btc"
  exit 1
fi

position_size="$(python3 - <<PY
spot = float("${spot}")
target = float("${TARGET_NOTIONAL_USDC}")
print(target / spot if spot > 0 else 0)
PY
)"

if [[ -z "${position_size}" || "${position_size}" == "0" ]]; then
  echo "Computed position size is zero; aborting."
  exit 1
fi

fixed_fee_for_tier() {
  local tier="$1"
  local fee
  fee="$(jq -r --arg tier "${tier}" '.[$tier] // empty' <<<"${FEE_MAP_JSON}")"
  if [[ -z "${fee}" || "${fee}" == "null" ]]; then
    fee="10"
  fi
  echo "${fee}"
}

echo "=========================================================================="
echo "Fixed-Notional Leverage Comparison (Canonical Venue: executionPlan+option)"
echo "API_BASE=${API_BASE}"
echo "Spot=${spot}"
echo "Target Notional (USDC)=${TARGET_NOTIONAL_USDC}"
echo "Derived positionSize (BTC)=${position_size}"
echo "Drawdown Floor=${DRAWDOWN_FLOOR_PCT}"
echo "Target Days=${TARGET_DAYS}"
echo "Side=${SIDE}"
echo "Tiers=${TIERS_CSV}"
echo "Leverages=${LEVERAGES_CSV}"
echo "=========================================================================="
echo

IFS=',' read -r -a TIERS <<< "${TIERS_CSV}"
IFS=',' read -r -a LEVERAGES <<< "${LEVERAGES_CSV}"

for tier in "${TIERS[@]}"; do
  tier="$(echo "${tier}" | sed 's/^ *//; s/ *$//')"
  fixed_fee="$(fixed_fee_for_tier "${tier}")"

  echo "Tier: ${tier} (fixedPriceUsdc=${fixed_fee})"
  printf "%-4s  %-14s  %-10s  %-10s  %-4s  %-10s  %-10s  %-10s  %-10s  %-24s  %-20s\n" \
    "Lev" "Status" "FeeUsdc" "Premium" "Days" "Selected" "Plan" "Option" "TopLevel" "Reason" "PricingReason"
  printf "%s\n" "--------------------------------------------------------------------------------------------------------------------------------"

  for lev in "${LEVERAGES[@]}"; do
    lev="$(echo "${lev}" | sed 's/^ *//; s/ *$//')"
    payload="$(jq -n \
      --arg tier "${tier}" \
      --argjson spot "${spot}" \
      --argjson drawdown "${DRAWDOWN_FLOOR_PCT}" \
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
        coverageId: "fixed-notional-test",
        targetDays: $days,
        allowPremiumPassThrough: true
      }')"

    response="$(curl -s "${API_BASE}/put/quote" -H "Content-Type: application/json" -d "${payload}")"
    status="$(echo "${response}" | jq -r '.status // "unknown"')"
    fee_usdc="$(echo "${response}" | jq -r '.feeUsdc // "-"')"
    premium="$(echo "${response}" | jq -r '.premiumUsdc // .rollEstimatedPremiumUsdc // "-"')"
    days_out="$(echo "${response}" | jq -r '.targetDays // "-"')"
    plan_venue="$(echo "${response}" | jq -r '.executionPlan[0].venue // "-"')"
    option_venue="$(echo "${response}" | jq -r '.optionVenue // .venueSelection.selected // "-"')"
    top_venue="$(echo "${response}" | jq -r '.venue // "-"')"
    reason="$(echo "${response}" | jq -r '.reason // "-"')"
    pricing_reason="$(echo "${response}" | jq -r '.pricingReason // "-"')"

    selected="${plan_venue}"
    if [[ "${selected}" == "-" || -z "${selected}" ]]; then
      selected="${option_venue}"
    fi

    printf "%-4s  %-14s  %-10s  %-10s  %-4s  %-10s  %-10s  %-10s  %-10s  %-24s  %-20s\n" \
      "${lev}" "${status}" "${fee_usdc}" "${premium}" "${days_out}" "${selected}" "${plan_venue}" "${option_venue}" "${top_venue}" "${reason}" "${pricing_reason}"
  done

  echo
done

echo "Done."
