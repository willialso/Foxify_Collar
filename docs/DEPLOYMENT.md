# Atticus MVP Deployment Guide

## Pre-Deployment Checklist

### Configuration
- Set required environment variables in `.env`
- Configure `DERIBIT_CLIENT_ID` and `DERIBIT_CLIENT_SECRET`
- Set `DERIBIT_ENV=live` for production
- Set `DERIBIT_PAPER=false` for real trading
- Ensure `RISK_CONTROLS_PATH` points to production config

### Security
- Rotate secrets from testnet values
- Store API keys in a secure vault
- Restrict CORS origins to known domains
- Enable rate limiting
- Install TLS certificates
- Configure firewall rules

### Testing
- Unit tests passing (95%+ coverage target)
- Integration tests passing
- Smoke tests run against staging
- Load tests completed (100 concurrent users)

### Infrastructure
- Audit log rotation configured
- Monitoring dashboards created
- Alerting rules configured
- Health check endpoints verified
- Rollback plan documented

### Business Validation
- Risk controls reviewed and approved
- Tier fees approved
- Subsidy caps confirmed
- Leverage limits validated
- Premium floor ratios verified

## Deployment Steps

1. Build container
```bash
docker build -t atticus-mvp:latest .
```

2. Run container
```bash
docker run -p 8000:8000 --env-file .env atticus-mvp:latest
```

3. Verify health
```bash
curl http://localhost:8000/health
```

## Rollback

- Re-deploy previous image tag
- Verify `/health` and `/audit/logs`
- Monitor error rate for 15 minutes

