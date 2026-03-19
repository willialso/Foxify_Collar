#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "Running pilot acceptance gates via scripts/pilot_uat.sh"
"${ROOT_DIR}/scripts/pilot_uat.sh"
