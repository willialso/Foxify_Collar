# Foxify Fixed-Floor Protection

Fixed-price protective put protection for FUNDED traders with MTM crediting, rolling hedges, and auto-renewal. Built to embed into the Foxify dashboard and run on Deribit testnet first, then live.

## Highlights
- Fixed-price protective put aligned to FUNDED drawdown floor by level.
- MTM crediting baked into equity + drawdown buffer.
- Rolling hedges to prevent drawdown breaches in real time.
- Auto-renew with expiry alerts.

## Quick Start
1. Copy `.env.example` to `.env` and fill in Deribit keys.
2. Install dependencies (once packages are wired to the build system).
3. Start API and web:
   - `npm run dev:api`
   - `npm run dev:web`

## Repository Layout
- `apps/web/` UI widget (TypeScript/React)
- `services/api/` API service (TypeScript/Fastify)
- `services/hedging/` MTM + rolling hedge engine
- `services/connectors/` Deribit connector (testnet + live)
- `packages/shared/` shared schemas and types
- `docs/` architecture, API, security, ops
- `contracts/` Rust interfaces (future on-chain hooks)

## Status
MVP scaffolding in progress. See `docs/architecture.md` for details.
