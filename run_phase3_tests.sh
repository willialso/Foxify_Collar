#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:4100}"
CONFIG_PATH="${CONFIG_PATH:-./configs/risk_controls.json}"
MODE="${MODE:-shadow}"
RESTORE_ON_EXIT="${RESTORE_ON_EXIT:-true}"
RUN_READINESS="${RUN_READINESS:-true}"
RUN_TESTS="${RUN_TESTS:-true}"
ROLLBACK_ONLY="${ROLLBACK_ONLY:-false}"
BACKUP_PATH="${BACKUP_PATH:-/tmp/risk_controls_phase3_backup.json}"

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

if [ ! -f "${CONFIG_PATH}" ]; then
  echo "Config file not found at ${CONFIG_PATH}"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

normalize_bool() {
  case "$1" in
    true|false) echo "$1" ;;
    *)
      echo "Invalid boolean: ${1} (expected true/false)" >&2
      exit 1
      ;;
  esac
}

restore_config() {
  if [ "${RESTORE_ON_EXIT}" = "true" ] && [ -f "${BACKUP_PATH}" ]; then
    cp "${BACKUP_PATH}" "${CONFIG_PATH}"
    echo "Restored config from ${BACKUP_PATH}"
  fi
}

if [ "${ROLLBACK_ONLY}" = "true" ]; then
  if [ -f "${BACKUP_PATH}" ]; then
    cp "${BACKUP_PATH}" "${CONFIG_PATH}"
    echo "Rollback complete using ${BACKUP_PATH}"
    exit 0
  fi
  echo "Rollback requested but backup not found at ${BACKUP_PATH}"
  exit 1
fi

cp "${CONFIG_PATH}" "${BACKUP_PATH}"
echo "Backup saved: ${BACKUP_PATH}"
trap restore_config EXIT

case "${MODE}" in
  shadow)
    safety_guard_default=true
    selection_shadow_default=true
    selection_live_default=false
    analytics_default=true
    profit_thresholds_default=true
    ;;
  live)
    safety_guard_default=false
    selection_shadow_default=false
    selection_live_default=true
    analytics_default=true
    profit_thresholds_default=true
    ;;
  *)
    echo "Unknown MODE: ${MODE} (expected shadow|live)"
    exit 1
    ;;
esac

PHASE3_ROLLOUT_ENABLED="$(normalize_bool "${PHASE3_ROLLOUT_ENABLED:-true}")"
PHASE3_SAFETY_GUARD_ENABLED="$(normalize_bool "${PHASE3_SAFETY_GUARD_ENABLED:-${safety_guard_default}}")"
INTERMITTENT_ANALYTICS_ENABLED="$(normalize_bool "${INTERMITTENT_ANALYTICS_ENABLED:-${analytics_default}}")"
INTERMITTENT_SELECTION_SHADOW_ENABLED="$(normalize_bool "${INTERMITTENT_SELECTION_SHADOW_ENABLED:-${selection_shadow_default}}")"
INTERMITTENT_SELECTION_LIVE_ENABLED="$(normalize_bool "${INTERMITTENT_SELECTION_LIVE_ENABLED:-${selection_live_default}}")"
INTERMITTENT_PROFIT_THRESHOLD_ENABLED="$(normalize_bool "${INTERMITTENT_PROFIT_THRESHOLD_ENABLED:-${profit_thresholds_default}}")"

tmp_file="$(mktemp)"
jq \
  --argjson phase3_rollout_enabled "${PHASE3_ROLLOUT_ENABLED}" \
  --argjson phase3_safety_guard_enabled "${PHASE3_SAFETY_GUARD_ENABLED}" \
  --argjson intermittent_analytics_enabled "${INTERMITTENT_ANALYTICS_ENABLED}" \
  --argjson intermittent_selection_shadow_enabled "${INTERMITTENT_SELECTION_SHADOW_ENABLED}" \
  --argjson intermittent_selection_live_enabled "${INTERMITTENT_SELECTION_LIVE_ENABLED}" \
  --argjson intermittent_profit_threshold_enabled "${INTERMITTENT_PROFIT_THRESHOLD_ENABLED}" \
  '.
  | .phase3_rollout_enabled = $phase3_rollout_enabled
  | .phase3_safety_guard_enabled = $phase3_safety_guard_enabled
  | .intermittent_analytics_enabled = $intermittent_analytics_enabled
  | .intermittent_selection_shadow_enabled = $intermittent_selection_shadow_enabled
  | .intermittent_selection_live_enabled = $intermittent_selection_live_enabled
  | .intermittent_profit_threshold_enabled = $intermittent_profit_threshold_enabled
  ' "${CONFIG_PATH}" > "${tmp_file}"
mv "${tmp_file}" "${CONFIG_PATH}"

echo "Phase 3 config applied:"
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

if [ "${RUN_READINESS}" = "true" ]; then
  echo "=== Phase 3 readiness ==="
  API_BASE="${API_BASE}" CONFIG_PATH="${CONFIG_PATH}" "${SCRIPT_DIR}/run_phase3_readiness.sh"
  echo
fi

if [ "${RUN_TESTS}" = "true" ]; then
  echo "=== Phase 3 test run ==="
  API_BASE="${API_BASE}" \
  CONFIG_PATH="${CONFIG_PATH}" \
  INCLUDE_EXPOSURES="${INCLUDE_EXPOSURES}" \
  FORCE_INCREASE="${FORCE_INCREASE}" \
  BUFFER_TARGET_PCT="${BUFFER_TARGET_PCT}" \
  HYSTERESIS_PCT="${HYSTERESIS_PCT}" \
  POSITION_SIZE="${POSITION_SIZE}" \
  LOOPS="${LOOPS}" \
  SLEEP_SECONDS="${SLEEP_SECONDS}" \
  LOG_LIMIT="${LOG_LIMIT}" \
  POST_LOG_DELAY_SECONDS="${POST_LOG_DELAY_SECONDS}" \
  "${SCRIPT_DIR}/run_intermittent_tests.sh"
  echo
fi

echo "Done. Set RESTORE_ON_EXIT=false to keep the Phase 3 config applied."
