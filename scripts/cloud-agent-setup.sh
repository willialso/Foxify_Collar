#!/usr/bin/env bash
set -euo pipefail

cd /workspace
echo "[cloud-setup] Installing workspace dependencies..."
npm install
echo "[cloud-setup] Dependencies ready."
