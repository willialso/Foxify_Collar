# FalconX Options RFQ Integration

This document describes how the pilot integration uses FalconX options RFQ APIs.

## Base URL

- Production: `https://api.falconx.io`
- Options endpoints: `/v3/derivatives/option/*`

## Authentication headers

All requests use:

- `FX-ACCESS-KEY`
- `FX-ACCESS-SIGN`
- `FX-ACCESS-TIMESTAMP`
- `FX-ACCESS-PASSPHRASE`

Signature format:

`base64(HMAC_SHA256(base64_decode(secret), timestamp + METHOD + requestPath + body))`

## Endpoints used

- `POST /v3/derivatives/option/quote`
- `POST /v3/derivatives/option/quote/execute`

Optional:

- `POST /v3/derivatives/option/quote/close_rfq`

## Runtime config

Set via environment variables:

- `FALCONX_BASE_URL`
- `FALCONX_API_KEY`
- `FALCONX_SECRET`
- `FALCONX_PASSPHRASE`

## Error mapping

Runtime maps venue errors to internal reasons:

- `QUOTE_EXPIRED` -> `quote_expired`
- `INVALID_QUOTE_ID` -> `invalid_quote_id`
- cooldown errors -> `execution_cooldown`
- insufficient balance/equity -> `insufficient_balance`
- otherwise -> `venue_error`

## Testing without FalconX credentials

Use:

- `PILOT_VENUE_MODE=mock_falconx` for deterministic local/CI tests
- `PILOT_VENUE_MODE=deribit_test` for execution smoke tests through Deribit paper mode

