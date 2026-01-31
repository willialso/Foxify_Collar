# Risk Engine

## Equity Formula
```
equity = cash + pnl_positions + mtm_hedges
```

## Drawdown Buffer
```
drawdown_buffer_usdc = equity - drawdown_limit_usdc
```

## MTM Crediting
- Options valued at mid/VWAP with spread checks.
- Perps valued at mark price.
- Stale feeds never increase equity.

## Option Selection (Fixed Price)
- Candidates must clear spread, slippage, and size thresholds from live order books.
- Scoring blends protection, premium efficiency, and liquidity:
  - Protection: strike proximity to drawdown floor.
  - Premium: price advantage vs fixed fee.
  - Liquidity: spread + available size.
  - Volatility: penalty when IV exceeds throttle threshold.
- Highest score wins, subject to hard constraints (budget, spread, slippage, size).

## Rolling Hedge Buffers
- Buffer target increases with leverage and implied volatility.
- High IV expands buffer to reduce drawdown breach risk.
