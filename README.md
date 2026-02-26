# Foxify Fixed-Floor Protection

Fixed-price protective put protection for FUNDED traders with MTM crediting, rolling hedges, and auto-renewal. Built to embed into the Foxify dashboard and run on Deribit testnet first, then live.

## Highlights
- Fixed-price protective put aligned to FUNDED drawdown floor by level.
- MTM crediting baked into equity + drawdown buffer.
- Rolling hedges to prevent drawdown breaches in real time.
- Auto-renew with expiry alerts.

## Quick Start
1. Copy `.env.example` to `.env` and fill in Deribit keys.
2. Install workspace dependencies from repo root: `npm install`.
3. Start API and web:
   - `npm run dev:api`
   - `npm run dev:web`

### Runtime source of truth
- API runtime code is canonical under `services/api/src`.
- Root-level `src/` is legacy test scaffolding and not used by `npm run dev:api`.

### Cloud Agent Bootstrap
- Repo includes `.cursor/environment.json` so cloud agents run:
  - `bash ./scripts/cloud-agent-setup.sh`
- This performs root workspace dependency install (`npm install`) before task execution.

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
