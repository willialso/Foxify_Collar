# Operations

## Environments
- `DERIBIT_ENV=testnet` for paper trading.
- `DERIBIT_ENV=live` for live trading.

## Deribit Auth
Set credentials in `.env`:
- `DERIBIT_CLIENT_ID`
- `DERIBIT_CLIENT_SECRET`

## Alerts
Configure `ALERT_WEBHOOK_URL` for expiry and renewal alerts.

## Loop Tick
Use `/loop/tick` to run a single control-cycle step (risk refresh + hedge + renew).

## Interval Runner
Set `LOOP_INTERVAL_MS` to enable a lightweight continuous loop (default 15000ms).
Set to `0` to disable.

## Account Config
Set `ACCOUNTS_CONFIG_PATH` to point at a JSON config (default `configs/live_accounts.json`).

## Config Validation + Hot Reload
The API validates configs on startup (fail fast) and keeps last known good config on hot reload.

## Audit Log
Audit events are appended to `logs/audit.log` in JSONL format.

## Risk Controls
Internal-only controls loaded from `configs/risk_controls.json`.
Use `GET /risk/daily-summary` for operator visibility.
