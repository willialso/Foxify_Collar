#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
PROOF_TOKEN="${PROOF_TOKEN:-proof-local}"
ADMIN_TOKEN="${ADMIN_TOKEN:-admin-local}"
EXPECT_PRICE_SOURCE="${EXPECT_PRICE_SOURCE:-reference_oracle}"
ENTRY_PRICE="${ENTRY_PRICE:-100000}"
INSTRUMENT_ID="${INSTRUMENT_ID:-BTC-USD-7D-P}"
TIER_NAME="${TIER_NAME:-Pro (Bronze)}"

for tool in curl jq python3; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing required tool: $tool"
    exit 1
  fi
done

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "PASS: $1"
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  echo "SKIP: $1"
  if [[ -n "${2:-}" ]]; then
    echo "  detail: $2"
  fi
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "FAIL: $1"
  if [[ -n "${2:-}" ]]; then
    echo "  detail: $2"
  fi
}

post_json() {
  local path="$1"
  local payload="$2"
  shift 2 || true
  curl -sS -X POST "${API_BASE}${path}" \
    -H "Content-Type: application/json" \
    "$@" \
    -d "$payload"
}

get_json() {
  local path="$1"
  shift || true
  curl -sS "${API_BASE}${path}" "$@"
}

quote_payload() {
  local protected_notional="$1"
  local exposure_notional="$2"
  local entry_price="$3"
  local instrument_id="${4:-$INSTRUMENT_ID}"
  local tier_name="${5:-$TIER_NAME}"
  local protection_type="${6:-long}"
  jq -n \
    --arg instrumentId "$instrument_id" \
    --arg tierName "$tier_name" \
    --arg protectionType "$protection_type" \
    --argjson protectedNotional "$protected_notional" \
    --argjson foxifyExposureNotional "$exposure_notional" \
    --argjson entryPrice "$entry_price" \
    '{
      protectedNotional: $protectedNotional,
      foxifyExposureNotional: $foxifyExposureNotional,
      entryPrice: $entryPrice,
      instrumentId: $instrumentId,
      tierName: $tierName,
      protectionType: $protectionType
    }'
}

activate_payload() {
  local protected_notional="$1"
  local exposure_notional="$2"
  local entry_price="$3"
  local quote_id="$4"
  local auto_renew="${5:-false}"
  local instrument_id="${6:-$INSTRUMENT_ID}"
  local tier_name="${7:-$TIER_NAME}"
  local protection_type="${8:-long}"
  jq -n \
    --arg instrumentId "$instrument_id" \
    --arg tierName "$tier_name" \
    --arg protectionType "$protection_type" \
    --arg quoteId "$quote_id" \
    --argjson protectedNotional "$protected_notional" \
    --argjson foxifyExposureNotional "$exposure_notional" \
    --argjson entryPrice "$entry_price" \
    --argjson autoRenew "$auto_renew" \
    '{
      protectedNotional: $protectedNotional,
      foxifyExposureNotional: $foxifyExposureNotional,
      entryPrice: $entryPrice,
      instrumentId: $instrumentId,
      tierName: $tierName,
      protectionType: $protectionType,
      autoRenew: $autoRenew,
      quoteId: $quoteId
    }'
}

echo "Running pilot UAT against ${API_BASE}"

# 1) Happy-path quote with server-anchored trigger verification
Q1="$(post_json "/pilot/protections/quote" "$(quote_payload 5000 5000 "$ENTRY_PRICE")")"
Q1_STATUS="$(echo "$Q1" | jq -r '.status // ""')"
Q1_SOURCE="$(echo "$Q1" | jq -r '.entrySnapshot.source // ""')"
Q1_TRIGGER_MATCH="$(
  python3 - <<'PY' "$Q1"
import json, sys
from decimal import Decimal
payload = json.loads(sys.argv[1])
if payload.get("status") != "ok":
    print("bad_status")
    raise SystemExit
entry = Decimal(str(payload["entrySnapshot"]["price"]))
drawdown = Decimal(str(payload["drawdownFloorPct"]))
trigger = Decimal(str(payload["triggerPrice"]))
expected = entry * (Decimal("1") - drawdown)
delta = abs(trigger - expected)
print("ok" if delta <= Decimal("0.000001") else f"mismatch:{expected}:{trigger}:{delta}")
PY
)"
if [[ "$Q1_STATUS" == "ok" && "$Q1_TRIGGER_MATCH" == "ok" ]]; then
  if [[ "$EXPECT_PRICE_SOURCE" == "any" || "$Q1_SOURCE" == "$EXPECT_PRICE_SOURCE" ]]; then
    pass "1 happy-path quote uses server anchor trigger + canonical source"
  else
    fail "1 happy-path quote uses server anchor trigger + canonical source" "source=$Q1_SOURCE expected=$EXPECT_PRICE_SOURCE"
  fi
else
  fail "1 happy-path quote uses server anchor trigger + canonical source" "$Q1_TRIGGER_MATCH :: $Q1"
fi

# 2) Over-cap quote
Q2="$(post_json "/pilot/protections/quote" "$(quote_payload 50001 60000 "$ENTRY_PRICE")")"
Q2_REASON="$(echo "$Q2" | jq -r '.reason // ""')"
[[ "$Q2_REASON" == "protection_notional_cap_exceeded" ]] \
  && pass "2 per-protection 50k cap enforced" \
  || fail "2 per-protection 50k cap enforced" "$Q2"

# 3) Protected > exposure
Q3="$(post_json "/pilot/protections/quote" "$(quote_payload 40000 30000 "$ENTRY_PRICE")")"
Q3_REASON="$(echo "$Q3" | jq -r '.reason // ""')"
[[ "$Q3_REASON" == "protected_notional_exceeds_exposure" ]] \
  && pass "3 protected notional cannot exceed exposure" \
  || fail "3 protected notional cannot exceed exposure" "$Q3"

# 4) Quote + activate happy path (entry source should be server snapshot)
Q4="$(post_json "/pilot/protections/quote" "$(quote_payload 1000 1000 "$ENTRY_PRICE")")"
Q4_ID="$(echo "$Q4" | jq -r '.quote.quoteId // ""')"
A4_STATUS_RAW="$(echo "$Q4" | jq -r '.status // ""')"
if [[ "$A4_STATUS_RAW" == "ok" && -n "$Q4_ID" ]]; then
  A4="$(post_json "/pilot/protections/activate" "$(activate_payload 1000 1000 "$ENTRY_PRICE" "$Q4_ID")")"
else
  A4='{"status":"error","reason":"quote_failed"}'
fi
A4_STATUS="$(echo "$A4" | jq -r '.status // ""')"
A4_PROTECTION_STATUS="$(echo "$A4" | jq -r '.protection.status // ""')"
A4_ENTRY_SOURCE="$(echo "$A4" | jq -r '.protection.entryPriceSource // ""')"
PID="$(echo "$A4" | jq -r '.protection.id // ""')"
if [[ "$A4_STATUS" == "ok" && "$A4_PROTECTION_STATUS" == "active" && "$A4_ENTRY_SOURCE" == "reference_snapshot_quote" && -n "$PID" ]]; then
  pass "4 quote-lock activation persists server reference entry source"
else
  fail "4 quote-lock activation persists server reference entry source" "$A4"
fi

# 5) Quote mismatch guard (altered protection context blocked)
Q5="$(post_json "/pilot/protections/quote" "$(quote_payload 1200 1200 "$ENTRY_PRICE" "BTC-USD-7D-P" "$TIER_NAME" "long")")"
Q5_ID="$(echo "$Q5" | jq -r '.quote.quoteId // ""')"
A5="$(post_json "/pilot/protections/activate" "$(activate_payload 1200 1200 "$ENTRY_PRICE" "$Q5_ID" false "BTC-USD-7D-C" "$TIER_NAME" "short")")"
A5_REASON="$(echo "$A5" | jq -r '.reason // ""')"
if [[ "$A5_REASON" == quote_mismatch_* ]]; then
  pass "5 quote mismatch guard blocks altered activation context"
else
  fail "5 quote mismatch guard blocks altered activation context" "$A5"
fi

# 6) Proof auth required
P6_NOAUTH="$(get_json "/pilot/protections/${PID}/proof")"
P6_AUTH="$(get_json "/pilot/protections/${PID}/proof" -H "x-proof-token: ${PROOF_TOKEN}")"
P6_NOAUTH_REASON="$(echo "$P6_NOAUTH" | jq -r '.reason // ""')"
P6_AUTH_STATUS="$(echo "$P6_AUTH" | jq -r '.status // ""')"
if [[ "$P6_NOAUTH_REASON" == "unauthorized_proof_access" && "$P6_AUTH_STATUS" == "ok" ]]; then
  pass "6 proof endpoint enforces token auth"
else
  fail "6 proof endpoint enforces token auth" "noauth=$P6_NOAUTH auth=$P6_AUTH"
fi

# 7) Proof payload minimality
if echo "$P6_AUTH" | jq -e '
  (.proof.protection | has("userHash") | not) and
  (.proof.protection | has("premium") | not) and
  (.proof | has("liquidity") | not) and
  (.proof | has("profitability") | not)
' >/dev/null; then
  pass "7 proof payload excludes internal economics/identity fields"
else
  fail "7 proof payload excludes internal economics/identity fields" "$P6_AUTH"
fi

# 8) Admin ledger auth
L8_NOAUTH="$(get_json "/pilot/admin/protections/${PID}/ledger")"
L8_AUTH="$(get_json "/pilot/admin/protections/${PID}/ledger" -H "x-admin-token: ${ADMIN_TOKEN}")"
L8_NOAUTH_REASON="$(echo "$L8_NOAUTH" | jq -r '.reason // ""')"
L8_AUTH_STATUS="$(echo "$L8_AUTH" | jq -r '.status // ""')"
if [[ "$L8_NOAUTH_REASON" == "unauthorized_admin" && "$L8_AUTH_STATUS" == "ok" ]]; then
  pass "8 admin ledger endpoint enforces admin token"
else
  fail "8 admin ledger endpoint enforces admin token" "noauth=$L8_NOAUTH auth=$L8_AUTH"
fi

# 9) Payout settlement before expiry is blocked
S9="$(post_json "/pilot/admin/protections/${PID}/payout-settled" '{"amount":1,"payoutTxRef":"uat-pre-expiry"}' -H "x-admin-token: ${ADMIN_TOKEN}")"
S9_REASON="$(echo "$S9" | jq -r '.reason // ""')"
if [[ "$S9_REASON" == "expiry_price_missing" ]]; then
  pass "9 payout settlement blocked before expiry price is resolved"
else
  fail "9 payout settlement blocked before expiry price is resolved" "$S9"
fi

# 10) Daily cap enforced at tenant scope (dynamic headroom check)
Q10_SEED="$(post_json "/pilot/protections/quote" "$(quote_payload 1 1 "$ENTRY_PRICE")")"
Q10_SEED_STATUS="$(echo "$Q10_SEED" | jq -r '.status // ""')"
if [[ "$Q10_SEED_STATUS" != "ok" ]]; then
  fail "10 tenant-scope daily cap enforcement" "seed_quote_failed=$Q10_SEED"
else
  Q10_CAP="$(echo "$Q10_SEED" | jq -r '.limits.maxDailyProtectedNotionalUsdc // "0"')"
  Q10_USED="$(echo "$Q10_SEED" | jq -r '.limits.dailyUsedUsdc // "0"')"
  Q10_AMOUNTS="$(
    python3 - <<'PY' "$Q10_CAP" "$Q10_USED"
from decimal import Decimal
import sys
cap = Decimal(sys.argv[1])
used = Decimal(sys.argv[2])
remaining = cap - used
if remaining <= Decimal("1.0"):
    print("skip")
else:
    first = remaining - Decimal("1.0")
    if first <= 0:
        print("skip")
    else:
        print(f"{first:.4f}|2")
PY
  )"
  if [[ "$Q10_AMOUNTS" == "skip" ]]; then
    skip "10 tenant-scope daily cap enforcement" "insufficient headroom (cap=$Q10_CAP used=$Q10_USED)"
  else
    Q10_FIRST="${Q10_AMOUNTS%%|*}"
    Q10_SECOND="${Q10_AMOUNTS##*|}"
    Q10A="$(post_json "/pilot/protections/quote" "$(quote_payload "$Q10_FIRST" "$Q10_FIRST" "$ENTRY_PRICE")")"
    Q10A_STATUS="$(echo "$Q10A" | jq -r '.status // ""')"
    Q10A_ID="$(echo "$Q10A" | jq -r '.quote.quoteId // ""')"
    if [[ "$Q10A_STATUS" == "ok" && -n "$Q10A_ID" ]]; then
      A10A="$(post_json "/pilot/protections/activate" "$(activate_payload "$Q10_FIRST" "$Q10_FIRST" "$ENTRY_PRICE" "$Q10A_ID")")"
    else
      A10A='{"status":"error","reason":"quote_failed"}'
    fi
    A10A_STATUS="$(echo "$A10A" | jq -r '.status // ""')"

    Q10B="$(post_json "/pilot/protections/quote" "$(quote_payload "$Q10_SECOND" "$Q10_SECOND" "$ENTRY_PRICE")")"
    Q10B_STATUS="$(echo "$Q10B" | jq -r '.status // ""')"
    Q10B_ID="$(echo "$Q10B" | jq -r '.quote.quoteId // ""')"
    if [[ "$Q10B_STATUS" == "ok" && -n "$Q10B_ID" ]]; then
      A10B="$(post_json "/pilot/protections/activate" "$(activate_payload "$Q10_SECOND" "$Q10_SECOND" "$ENTRY_PRICE" "$Q10B_ID")")"
    else
      A10B='{"status":"error","reason":"quote_failed"}'
    fi
    A10B_REASON="$(echo "$A10B" | jq -r '.reason // ""')"
    if [[ "$A10A_STATUS" == "ok" && "$Q10B_STATUS" == "ok" && "$A10B_REASON" == "daily_notional_cap_exceeded" ]]; then
      pass "10 tenant-scope daily cap enforced on activation"
    else
      fail "10 tenant-scope daily cap enforced on activation" "first_quote=$Q10A first_activate=$A10A second_quote=$Q10B second_activate=$A10B"
    fi
  fi
fi

echo
echo "UAT Summary: pass=${PASS_COUNT} fail=${FAIL_COUNT} skip=${SKIP_COUNT}"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi

