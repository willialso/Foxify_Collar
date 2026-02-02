#!/bin/bash

echo "════════════════════════════════════════════════════════════"
echo "BRONZE TIER PREMIUM ANALYSIS"
echo "Purpose: Evaluate $20 flat fee impact across position sizes"
echo "Current BTC Price: \$77,500"
echo "Test Date: $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════════════════════"
echo ""

# Check server running
if ! curl -s http://localhost:4100/health > /dev/null 2>&1; then
  echo "❌ Server not running on port 4100"
  exit 1
fi
echo "✅ Server running"
echo ""

# Initialize tracking arrays
declare -a POSITIONS=("250" "500" "1000" "1500" "2000" "2500")
declare -a PREMIUMS=()
declare -a BYBIT_PRICES=()
declare -a DERIBIT_PRICES=()
declare -a SAVINGS=()
declare -a VENUES=()

# Bronze tier config
TIER="Pro (Bronze)"
LEVERAGE=2       # Bronze allows 2-4× for puts
DRAWDOWN=0.10    # 10% max loss (conservative)
DAYS=5           # 5-day protection (moderate)

echo "═══════════════════════════════════════════════════════════"
echo "BRONZE TIER CONFIGURATION"
echo "═══════════════════════════════════════════════════════════"
echo "Tier: $TIER"
echo "Leverage: ${LEVERAGE}× (Bronze minimum)"
echo "Max Drawdown: 10%"
echo "Protection Period: 5 days"
echo "Side: Long (put protection)"
echo ""
echo "Testing Position Sizes: \$250, \$500, \$1000, \$1500, \$2000, \$2500"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ═══════════════════════════════════════════════════════════════
# TEST LOOP: Run 6 tests for each position size
# ═══════════════════════════════════════════════════════════════

for i in "${!POSITIONS[@]}"; do
  POSITION=${POSITIONS[$i]}
  TEST_NUM=$((i + 1))
  
  # Calculate BTC position size (Position / (BTC price × leverage))
  BTC_SIZE=$(awk "BEGIN {printf \"%.6f\", $POSITION / (77500 * $LEVERAGE)}")
  
  echo "════════════════════════════════════════════════════════════"
  echo "TEST $TEST_NUM/6: Bronze Trader - \$$POSITION Position"
  echo "════════════════════════════════════════════════════════════"
  echo "Position: Long $BTC_SIZE BTC @ ${LEVERAGE}× = \$$POSITION notional"
  echo "Strategy: 5-day put protection, 10% max loss"
  echo "────────────────────────────────────────────────────────────"
  
  START=$(date +%s)
  RESPONSE=$(curl -s -X POST http://localhost:4100/put/quote \
    -H "Content-Type: application/json" \
    -d "{
      \"side\": \"long\",
      \"tierName\": \"$TIER\",
      \"asset\": \"BTC\",
      \"spotPrice\": 77500,
      \"fixedPriceUsdc\": 100,
      \"positionSize\": $BTC_SIZE,
      \"leverage\": $LEVERAGE,
      \"drawdownFloorPct\": $DRAWDOWN,
      \"targetDays\": $DAYS,
      \"allowPremiumPassThrough\": true
    }")
  END=$(date +%s)
  ELAPSED=$((END - START))
  
  # Extract response data
  PREMIUM=$(echo "$RESPONSE" | jq -r '.premiumUsdc // 0')
  VENUE=$(echo "$RESPONSE" | jq -r '.optionVenue // "unknown"')
  DERIBIT=$(echo "$RESPONSE" | jq -r '.venueComparison.prices.deribit // "N/A"')
  BYBIT=$(echo "$RESPONSE" | jq -r '.venueComparison.prices.bybit // "N/A"')
  VENUE_SAVINGS=$(echo "$RESPONSE" | jq -r '.venueComparison.savingsUsdc // 0')
  STATUS=$(echo "$RESPONSE" | jq -r '.status // "unknown"')
  CACHED=$(echo "$RESPONSE" | jq -r '.cached // false')
  
  # Store in arrays
  PREMIUMS+=("$PREMIUM")
  BYBIT_PRICES+=("$BYBIT")
  DERIBIT_PRICES+=("$DERIBIT")
  SAVINGS+=("$VENUE_SAVINGS")
  VENUES+=("$VENUE")
  
  # Display results
  echo "Results:"
  echo "  Status: $STATUS"
  echo "  Selected Venue: $VENUE"
  echo "  "
  echo "  💰 PRICING BREAKDOWN:"
  echo "  ├─ Bybit Option Price:   \$$BYBIT"
  echo "  ├─ Deribit Option Price: \$$DERIBIT"
  echo "  ├─ Selected Price:       \$$PREMIUM (venue: $VENUE)"
  echo "  └─ Venue Savings:        \$$VENUE_SAVINGS"
  echo "  "
  echo "  📊 CURRENT BRONZE MODEL (WITH \$20 FLAT FEE):"
  
  # Calculate with $20 flat fee
  OPTION_COST=$PREMIUM
  FLAT_FEE=20
  TOTAL_WITH_FEE=$(echo "$OPTION_COST + $FLAT_FEE" | bc)
  FEE_PERCENTAGE=$(awk "BEGIN {printf \"%.1f\", ($FLAT_FEE / $TOTAL_WITH_FEE) * 100}")
  
  echo "  ├─ Option Cost:          \$$OPTION_COST"
  echo "  ├─ Flat Fee:             \$$FLAT_FEE"
  echo "  ├─ Total to User:        \$$TOTAL_WITH_FEE"
  echo "  └─ Fee as % of Total:    $FEE_PERCENTAGE%"
  echo "  "
  echo "  📊 PROPOSED MODEL (NO FLAT FEE):"
  echo "  ├─ Option Cost:          \$$OPTION_COST"
  echo "  ├─ Flat Fee:             \$0"
  echo "  ├─ Total to User:        \$$OPTION_COST"
  echo "  └─ User Saves:           \$$FLAT_FEE ($FEE_PERCENTAGE% cheaper)"
  echo "  "
  echo "  ⏱️  Response Time: ${ELAPSED}s"
  echo "  💾 Cached: $CACHED"
  echo ""
  
  # Small delay between tests
  sleep 2
done

# ═══════════════════════════════════════════════════════════════
# BUSINESS ANALYSIS SUMMARY
# ═══════════════════════════════════════════════════════════════

echo "════════════════════════════════════════════════════════════"
echo "📊 BUSINESS ANALYSIS: \$20 FLAT FEE IMPACT"
echo "════════════════════════════════════════════════════════════"
echo ""

echo "PREMIUM BREAKDOWN BY POSITION SIZE:"
echo "────────────────────────────────────────────────────────────"
printf "%-10s | %-12s | %-12s | %-12s | %-12s | %-10s\n" "Position" "Option Cost" "With \$20 Fee" "Fee %" "Venue" "Savings"
echo "-----------|--------------|--------------|--------------|--------------|------------"

for i in "${!POSITIONS[@]}"; do
  POS="\$${POSITIONS[$i]}"
  OPT="\$${PREMIUMS[$i]}"
  TOTAL=$(echo "${PREMIUMS[$i]} + 20" | bc)
  FEE_PCT=$(awk "BEGIN {printf \"%.1f\", (20 / $TOTAL) * 100}")
  VEN="${VENUES[$i]}"
  SAV="\$${SAVINGS[$i]}"
  
  printf "%-10s | %-12s | \$%-11.2f | %-11s%% | %-12s | %-10s\n" "$POS" "$OPT" "$TOTAL" "$FEE_PCT" "$VEN" "$SAV"
done

echo ""
echo "KEY METRICS:"
echo "────────────────────────────────────────────────────────────"

# Calculate averages
TOTAL_PREMIUM=0
TOTAL_SAVINGS=0
for i in "${!PREMIUMS[@]}"; do
  TOTAL_PREMIUM=$(echo "$TOTAL_PREMIUM + ${PREMIUMS[$i]}" | bc)
  TOTAL_SAVINGS=$(echo "$TOTAL_SAVINGS + ${SAVINGS[$i]}" | bc)
done

AVG_PREMIUM=$(echo "scale=2; $TOTAL_PREMIUM / 6" | bc)
AVG_SAVINGS=$(echo "scale=2; $TOTAL_SAVINGS / 6" | bc)
AVG_WITH_FEE=$(echo "$AVG_PREMIUM + 20" | bc)
AVG_FEE_PCT=$(awk "BEGIN {printf \"%.1f\", (20 / $AVG_WITH_FEE) * 100}")

echo "Average Option Cost:        \$$AVG_PREMIUM"
echo "Average With \$20 Fee:       \$$AVG_WITH_FEE"
echo "Average Fee as % of Total:  $AVG_FEE_PCT%"
echo "Average Venue Savings:      \$$AVG_SAVINGS"
echo ""

# Venue breakdown
BYBIT_COUNT=0
DERIBIT_COUNT=0
for venue in "${VENUES[@]}"; do
  [ "$venue" = "bybit" ] && BYBIT_COUNT=$((BYBIT_COUNT + 1))
  [ "$venue" = "deribit" ] && DERIBIT_COUNT=$((DERIBIT_COUNT + 1))
done

echo "Venue Selection:"
echo "  Bybit Selected:   $BYBIT_COUNT/6 times"
echo "  Deribit Selected: $DERIBIT_COUNT/6 times"
echo ""

echo "════════════════════════════════════════════════════════════"
echo "💡 FLAT FEE IMPACT ANALYSIS"
echo "════════════════════════════════════════════════════════════"
echo ""

# Find smallest and largest positions
MIN_PREMIUM=${PREMIUMS}
MAX_PREMIUM=${PREMIUMS}
MIN_POS=${POSITIONS}
MAX_POS=${POSITIONS}

for i in "${!PREMIUMS[@]}"; do
  if (( $(echo "${PREMIUMS[$i]} < $MIN_PREMIUM" | bc -l) )); then
    MIN_PREMIUM=${PREMIUMS[$i]}
    MIN_POS=${POSITIONS[$i]}
  fi
  if (( $(echo "${PREMIUMS[$i]} > $MAX_PREMIUM" | bc -l) )); then
    MAX_PREMIUM=${PREMIUMS[$i]}
    MAX_POS=${POSITIONS[$i]}
  fi
done

MIN_TOTAL=$(echo "$MIN_PREMIUM + 20" | bc)
MIN_FEE_PCT=$(awk "BEGIN {printf \"%.1f\", (20 / $MIN_TOTAL) * 100}")

MAX_TOTAL=$(echo "$MAX_PREMIUM + 20" | bc)
MAX_FEE_PCT=$(awk "BEGIN {printf \"%.1f\", (20 / $MAX_TOTAL) * 100}")

echo "FLAT FEE BURDEN:"
echo "────────────────────────────────────────────────────────────"
echo "Smallest Position (\$$MIN_POS):"
echo "  Option Cost:  \$$MIN_PREMIUM"
echo "  With \$20 Fee: \$$MIN_TOTAL"
echo "  Fee Impact:   $MIN_FEE_PCT% of total ⚠️"
echo ""
echo "Largest Position (\$$MAX_POS):"
echo "  Option Cost:  \$$MAX_PREMIUM"
echo "  With \$20 Fee: \$$MAX_TOTAL"
echo "  Fee Impact:   $MAX_FEE_PCT% of total"
echo ""

echo "════════════════════════════════════════════════════════════"
echo "🎯 RECOMMENDATION ANALYSIS"
echo "════════════════════════════════════════════════════════════"
echo ""

# Decision logic based on fee percentages
if (( $(echo "$MIN_FEE_PCT > 40" | bc -l) )); then
  echo "⚠️  RECOMMENDATION: REMOVE \$20 FLAT FEE"
  echo ""
  echo "REASONING:"
  echo "  - Fee represents $MIN_FEE_PCT% of total for small positions"
  echo "  - This is REGRESSIVE (hurts smaller traders more)"
  echo "  - Bronze tier = entry level (should be affordable)"
  echo "  - Flat fee adds significant burden to micro positions"
  echo ""
  echo "IMPACT OF REMOVING FEE:"
  echo "  - Small traders (\$$MIN_POS): Save \$20 ($MIN_FEE_PCT% cheaper)"
  echo "  - Large traders (\$$MAX_POS): Save \$20 ($MAX_FEE_PCT% cheaper)"
  echo "  - Average Bronze user: Save \$20 ($AVG_FEE_PCT% cheaper)"
  echo ""
  echo "BUSINESS BENEFIT:"
  echo "  - More accessible to new traders"
  echo "  - Competitive with venues (pure pass-through)"
  echo "  - Higher Bronze tier adoption"
  echo "  - Upsell to Silver easier (demonstrate value first)"
elif (( $(echo "$MIN_FEE_PCT > 25" | bc -l) )); then
  echo "⚖️  RECOMMENDATION: CONSIDER REDUCING FLAT FEE"
  echo ""
  echo "REASONING:"
  echo "  - Fee represents $MIN_FEE_PCT% for smallest positions"
  echo "  - Moderate burden on entry-level traders"
  echo "  - Consider tiered flat fee (e.g., \$10 for <\$1000)"
  echo ""
  echo "ALTERNATIVES:"
  echo "  1. Remove flat fee entirely (simplest)"
  echo "  2. Reduce to \$10 flat fee (50% less burden)"
  echo "  3. Tiered: \$0 for <\$500, \$10 for \$500-\$1500, \$20 for >\$1500"
else
  echo "✅ RECOMMENDATION: KEEP \$20 FLAT FEE"
  echo ""
  echo "REASONING:"
  echo "  - Fee represents only $MIN_FEE_PCT% of total (reasonable)"
  echo "  - Covers platform operational costs"
  echo "  - Not overly burdensome to users"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "📈 REVENUE IMPACT PROJECTION (IF FEE REMOVED)"
echo "════════════════════════════════════════════════════════════"
echo ""

echo "ASSUMPTIONS:"
echo "  - 30% of quotes are Bronze tier"
echo "  - 100 quotes/day total = 30 Bronze quotes/day"
echo ""

BRONZE_DAILY=30
BRONZE_MONTHLY=$(echo "$BRONZE_DAILY * 30" | bc)
MONTHLY_FEE_REVENUE=$(echo "$BRONZE_MONTHLY * 20" | bc)
ANNUAL_FEE_REVENUE=$(echo "$MONTHLY_FEE_REVENUE * 12" | bc)

echo "CURRENT FLAT FEE REVENUE:"
echo "  Daily:   $BRONZE_DAILY quotes × \$20 = \$$(echo "$BRONZE_DAILY * 20" | bc)"
echo "  Monthly: $BRONZE_MONTHLY quotes × \$20 = \$$MONTHLY_FEE_REVENUE"
echo "  Annual:  \$$ANNUAL_FEE_REVENUE"
echo ""

echo "IF FEE REMOVED:"
echo "  Lost Revenue: \$$ANNUAL_FEE_REVENUE/year"
echo ""

echo "POTENTIAL BENEFITS (IF FEE REMOVED):"
echo "  - Higher Bronze adoption (more users)"
echo "  - Better conversion to Silver/Gold (upsell)"
echo "  - Competitive advantage (pure pass-through)"
echo "  - Simpler pricing (easier to explain)"
echo ""

echo "TRADE-OFF:"
echo "  Lose: \$$ANNUAL_FEE_REVENUE/year in flat fees"
echo "  Gain: Potential higher volume + tier upgrades"
echo ""

echo "════════════════════════════════════════════════════════════"
echo ""
