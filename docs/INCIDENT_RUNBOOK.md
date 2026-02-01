# Incident Runbook

## Severity Levels
- Sev1: Trading halted, incorrect pricing, or data breach
- Sev2: Partial outage, degraded performance
- Sev3: Non-critical errors, minor data issues

## On-Call Checklist
1. Confirm alert source and severity
2. Check `/health` and `/metrics`
3. Review recent audit logs (`/audit/logs`)
4. Inspect error logs from server
5. Determine blast radius (single account vs system-wide)

## Common Incidents

### Deribit API Errors
- Symptoms: pricing failures, execution errors
- Actions:
  - Verify credentials and environment
  - Switch to testnet if needed
  - Enable fallback pricing (CTC disabled)
  - Monitor error rate

### IV Ladder Stale
- Symptoms: CTC unavailable, fallback pricing used
- Actions:
  - Check WebSocket connectivity
  - Restart service if ladder not recovering
  - Verify Deribit status

### Execution Failures
- Symptoms: `/coverage/activate` returns failed
- Actions:
  - Check liquidity filters and slippage settings
  - Enable perp fallback if disabled
  - Reduce target size temporarily

## Rollback Procedure
1. Deploy previous container image
2. Verify `/health` and `/pricing/ctc`
3. Monitor logs for 15 minutes

## Escalation
- Notify on-call lead
- Post update in incident channel
- Provide timeline, impact, and mitigation

