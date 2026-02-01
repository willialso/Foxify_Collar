# Premium Pass-Through System

## Overview
When market volatility pushes hedge premiums above base fees, the platform charges users the
actual hedge cost within tier- and leverage-based caps. This keeps protection active while
maintaining transparent pricing and risk-managed exposure.

## Pricing Tiers

| Tier | Leverage 1x | Leverage 2x | Leverage 5x | Leverage 10x |
|------|-------------|-------------|-------------|--------------|
| Pro (Bronze) | 4.0x | 3.5x | 2.5x | 2.0x |
| Pro (Silver) | 6.0x | 5.0x | 3.5x | 3.0x |
| Pro (Gold) | 8.0x | 6.5x | 4.5x | 4.0x |
| Pro (Platinum) | 10.0x | 8.0x | 6.0x | 5.0x |

## User Experience

### Normal Quote (Premium <= 1.25x Base Fee)
User pays the base fee. Platform margin remains positive.

### Pass-Through (Premium Above Threshold, Under Cap)
User pays the actual hedge premium. Platform margin remains neutral.

### Capped Pass-Through (Premium Above Cap)
User pays the capped fee for their tier and leverage. The platform subsidizes the excess so
the protection remains active and fully hedged.

### Rejected (Premium Above Cap, No Subsidy Available)
Quote is rejected with actionable suggestions to reduce leverage, shorten duration, or
upgrade tiers for higher caps.

## CEO Talking Points

- "We charge actual hedge costs with full transparency."
- "Tier-based caps protect users from extreme volatility."
- "Platform subsidies are explicit and auditable."
- "Every decision is logged for compliance."
