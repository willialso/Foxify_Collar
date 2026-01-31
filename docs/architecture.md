# Architecture

## Core Flow
1. Fetch positions + account rules.
2. Compute equity with MTM crediting.
3. Allocate hedge budget using priority risk ranking.
4. Build fixed-price protective put aligned to drawdown floor.
5. Execute and roll hedges to maintain drawdown buffer.
6. Auto-renew before expiry; alert on approaching expiry.

## Components
- **Risk Engine**: net equity + drawdown buffer (includes hedge MTM).
- **Put Builder**: floor strike selection for fixed price and liquidity checks.
- **Hedge Orchestrator**: rolling adjustments and renewals.
- **Deribit Connector**: testnet/live trading + paper mode.
- **Widget UI**: single-screen protection status and activation.

## Execution Safeguards
- **Liquidity gates**: minimum size, maximum spread, and maximum slippage thresholds.
- **Score-based selection**: balances protection, premium efficiency, and liquidity.
- **Volatility-aware buffers**: buffer targets adjust to IV regimes.
