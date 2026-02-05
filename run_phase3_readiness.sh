#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
CONFIG_PATH="${CONFIG_PATH:-./configs/risk_controls.json}"
MIN_COVERAGE_RATIO="${MIN_COVERAGE_RATIO:-0.98}"
TEST_COVERAGE_ID="${TEST_COVERAGE_ID:-test-intermittent}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install with: brew install jq (mac) or apt-get install jq (linux)"
  exit 1
fi

echo "=== Phase 3 Readiness Check ==="
echo "API_BASE=${API_BASE}"
echo "CONFIG_PATH=${CONFIG_PATH}"
echo "MIN_COVERAGE_RATIO=${MIN_COVERAGE_RATIO}"
echo "TEST_COVERAGE_ID=${TEST_COVERAGE_ID}"
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

summary="$(curl -s "${API_BASE}/audit/summary?mode=internal")"
logs="$(curl -s "${API_BASE}/audit/logs?limit=500&showAll=true")"
filtered_logs="$(echo "${logs}" | jq --arg cid "${TEST_COVERAGE_ID}" '{
  entries: [.entries[] | select((.payload.coverageId // "") == $cid)]
}')"

echo "Summary snapshot:"
echo "${summary}" | jq
echo

total_entries="$(echo "${filtered_logs}" | jq '.entries | length')"
eval_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="intermittent_hedge_eval")] | length')"
eval_live_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="intermittent_hedge_eval") | select(.payload.selectionMode=="live")] | length')"
eval_shadow_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="intermittent_hedge_eval") | select(.payload.selectionMode=="shadow")] | length')"
selection_error_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="intermittent_hedge_eval") | select(.payload.selectionError!=null)] | length')"
hedge_action_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="hedge_action")] | length')"
hedge_skip_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="hedge_action_skipped")] | length')"
close_blocked_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="close_blocked")] | length')"
demo_credit_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="demo_credit")] | length')"
mtm_credit_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="mtm_credit")] | length')"
mtm_position_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="mtm_position")] | length')"
low_ratio_count="$(echo "${filtered_logs}" | jq --argjson min "${MIN_COVERAGE_RATIO}" '[.entries[] | select(.event=="mtm_position") | .payload.coverageRatio | tonumber?] | map(select(.!=null and . < $min)) | length')"
negative_buffer_count="$(echo "${filtered_logs}" | jq '[.entries[] | select(.event=="mtm_position") | .payload.drawdownBufferUsdc | tonumber?] | map(select(.!=null and . < 0)) | length')"

echo "Log totals:"
echo "  total_entries: ${total_entries}"
echo "  intermittent_hedge_eval: ${eval_count}"
echo "    - shadow: ${eval_shadow_count}"
echo "    - live: ${eval_live_count}"
echo "  selection_error_count: ${selection_error_count}"
echo "  hedge_action: ${hedge_action_count}"
echo "  hedge_action_skipped: ${hedge_skip_count}"
echo "  mtm_position: ${mtm_position_count}"
echo "  mtm_credit: ${mtm_credit_count}"
echo "  demo_credit: ${demo_credit_count}"
echo "  close_blocked: ${close_blocked_count}"
echo "  low_coverage_ratio(<${MIN_COVERAGE_RATIO}): ${low_ratio_count}"
echo "  negative_buffer: ${negative_buffer_count}"
echo

echo "Hedge action skipped reasons (top 10):"
echo "${filtered_logs}" | jq -r '[.entries[] | select(.event=="hedge_action_skipped") | .payload.reason] | group_by(.) | map({reason: .[0], count: length}) | sort_by(-.count) | .[0:10]'
echo

echo "Recent intermittent_hedge_eval (latest 5):"
echo "${filtered_logs}" | jq -r '[.entries[] | select(.event=="intermittent_hedge_eval")] | .[0:5]'
echo

echo "Readiness checks (advisory):"
if [ "${close_blocked_count}" -gt 0 ]; then
  echo "  ⚠️  close_blocked events present: ${close_blocked_count}"
else
  echo "  ✅ No close_blocked events detected"
fi

if [ "${low_ratio_count}" -gt 0 ]; then
  echo "  ⚠️  Coverage ratio below ${MIN_COVERAGE_RATIO}: ${low_ratio_count}"
else
  echo "  ✅ Coverage ratio at/above ${MIN_COVERAGE_RATIO}"
fi

if [ "${selection_error_count}" -gt 0 ]; then
  echo "  ⚠️  Selection errors in intermittent_hedge_eval: ${selection_error_count}"
else
  echo "  ✅ No selection errors detected"
fi

echo
echo "Done."
