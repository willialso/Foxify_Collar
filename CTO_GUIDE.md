# ATTICUS - CTO TECHNICAL GUIDE
**Platform:** Options Protection Pricing Engine  
**Status:** Production Demo Ready (97% Confidence)  
**Date:** February 1, 2026

***

## 1. CORE SYSTEM LOGIC

### 1.1 PRICING ENGINE

**What it does:** Calculates option premium cost using orderbook data  
**Function:** Determines how much user pays for protection  
**Location:** `services/api/src/server.ts` (inside `/put/quote` handler)

**How to find it:**
```bash
grep -n "premium.*=\|calculatePremium\|optionPrice" services/api/src/server.ts | head -20
```

**Logic flow:**

text
1. Get current BTC spot price from Deribit
2. Calculate strike price based on drawdown floor
3. Calculate expiry date from targetDays
4. Query Deribit orderbook for option at that strike/expiry
5. Extract best ask price (cost to buy option)
6. premium = orderbook_ask_price × position_size

**Code snippet (search for this pattern):**

```typescript
// Pattern to search for in server.ts:
const premium = orderbook.best_ask_price * positionSize;
// or
const optionCost = calculateCostToCreate(strike, expiry, volatility);
```

**Diagram:**

text
┌─────────────────┐
│  User Request   │
│  Leverage: 5×   │
│  Drawdown: 20%  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────────┐
│ Calculate       │      │ Deribit API      │
│ Strike Price    │─────▶│ Get orderbook    │
│ $105,000        │      │ BTC-105000-C     │
└─────────────────┘      └────────┬─────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │ Premium = $250  │
                         │ (orderbook ask) │
                         └─────────────────┘

### 1.2 HEDGING ENGINE

**What it does:** Determines hedge coverage and platform subsidy  
**Function:** Calculates how much platform pays vs user pays  
**Location:** `services/api/src/server.ts` (after pricing, before response)

**How to find it:**
```bash
grep -n "hedgeSize\|subsidyUsdc\|pass_through" services/api/src/server.ts | head -30
```

**Logic flow:**

text
1. Start with full hedge: hedgeSize = 1.0 (100%)
2. Get tier cap from risk_controls.json
3. Calculate max user premium: position × leverage × spot × cap%
4. If actual premium > max premium:
   - User pays: max premium
   - Platform pays: actual premium - max premium (subsidy)
   - Status: "pass_through_capped"
5. If actual premium ≤ max premium:
   - User pays: actual premium
   - Platform pays: $0
   - Status: "pass_through" or "ok"

**Code snippet (search for this pattern):**

```typescript
// Pattern to search for:
const tierCap = riskControls.tier_premium_caps[tierName];
const maxPremium = positionSize * leverage * spotPrice * tierCap;

if (premium > maxPremium) {
  subsidyUsdc = premium - maxPremium;
  status = "pass_through_capped";
  hedgeSize = 1.0; // Still full hedge
} else {
  subsidyUsdc = 0;
  status = "pass_through";
}
```

**Diagram:**

text
Actual Premium: $400
User Tier: Silver (5% cap)
Position: 1 BTC × 5× leverage = $500k notional

┌────────────────────────────────────────┐
│ Tier Cap Calculation                   │
│ Max Premium = $500k × 5% = $25,000     │
└────────────────┬───────────────────────┘
                 │
                 ▼
         Premium ($400) < Cap ($25k)?
                 │
                 ├─ YES ──▶ User pays $400
                 │          Subsidy: $0
                 │
                 └─ NO ───▶ User pays $25k
                            Subsidy: $400 - $25k
                            (in this example: no subsidy needed)

For $30k premium scenario:
         Premium ($30k) > Cap ($25k)
                 │
                 └─────▶ User pays: $25k
                         Platform subsidy: $5k
                         Hedge: 100% (full coverage)

### 1.3 TIER VALIDATION LOGIC

**What it does:** Enforces tier-specific constraints  
**Function:** Blocks unsupported scenarios (excess leverage)  
**Location:** `services/api/src/server.ts` (early in handler, before pricing)

**How to find it:**
```bash
grep -n "leverage_exceeded\|max_leverage_by_tier" services/api/src/server.ts
```

**Logic flow:**

text
1. Determine option type: side="short" → call, side="long" → put
2. Check leverage against tier limits
3. If leverage > max → REJECT with suggestions
4. Continue to pricing

**Code snippet (search for this pattern):**

```typescript
const optionType = side === "long" ? "put" : "call";
const tierLeverageLimits = riskControls.max_leverage_by_tier?.[tierName];
if (tierLeverageLimits) {
  const maxLeverageForOption = tierLeverageLimits[optionType];
  if (Number.isFinite(maxLeverageForOption) && leverage > maxLeverageForOption) {
    // reject with leverage_exceeded
  }
}
```

**Diagram:**

text
┌──────────────┐
│ User Request │
└──────┬───────┘
       │
       ▼
 Determine option type
       │
       ▼
 Check leverage limits
       │
       ├── Exceeds max ──▶ ❌ REJECT
       │
       ▼
 Continue to pricing

### 1.4 CACHE SYSTEM

**What it does:** Stores quote responses to avoid repeated API calls  
**Function:** Makes 2nd identical request instant (2ms vs 20s)  
**Location:** `services/api/src/server.ts` (top: cache functions, bottom: cacheAndReturn)

**How to find it:**
```bash
grep -n "QUOTE_CACHE_TTL\|cacheAndReturn\|getQuoteCache" services/api/src/server.ts
```

**Logic flow:**

text
1. Hash request parameters → cacheKey
2. Check if cached response exists
3. Check if cache is fresh (<5 min old)
4. If fresh → return cached (2-3ms)
5. If stale/missing → calculate fresh quote (20-30s)
6. Store fresh response in cache with timestamp

**Code snippet (search for this pattern):**

```typescript
// Cache TTL setting:
const QUOTE_CACHE_TTL_MS = 300000; // 5 minutes

// Cache check:
const cacheKey = JSON.stringify(requestParams);
const cached = getQuoteCache(cacheKey);

if (cached && Date.now() - cached.timestamp < QUOTE_CACHE_TTL_MS) {
  return cached.response; // Instant return
}

// ... expensive calculation ...

cacheAndReturn(cacheKey, response); // Store for next request
```

**Diagram:**

text
Request 1                Request 2 (identical)
    │                           │
    ▼                           ▼
┌─────────┐               ┌─────────┐
│ Cache?  │               │ Cache?  │
│ NO      │               │ YES     │
└────┬────┘               └────┬────┘
     │                         │
     ▼                         ▼
┌──────────────┐         ┌──────────┐
│ Call Deribit │         │ Return   │
│ API (20-30s) │         │ cached   │
└──────┬───────┘         │ (2-3ms)  │
       │                 └──────────┘
       ▼
┌──────────────┐
│ Store in     │
│ cache        │
└──────────────┘

## 2. CONFIGURATION FILES

### 2.1 RISK CONTROLS

**Location:** `configs/risk_controls.json`

**What's inside:**

```json
{
  "max_leverage_by_tier": {
    "Pro (Bronze)": { "put": 10, "call": 10 },
    "Pro (Silver)": { "put": 10, "call": 10 },
    "Pro (Gold)": { "put": 10, "call": 10 },
    "Pro (Platinum)": { "put": 10, "call": 10 }
  },
  "tier_premium_caps": {
    "Pro (Bronze)": { "2x": { "put": 0.02 }, "4x": { "put": 0.04 } },
    "Pro (Silver)": { "call": 0.05, "put": 0.05 },
    "Pro (Gold)": { "call": 0.065, "put": 0.065 },
    "Pro (Platinum)": { "call": 0.08, "put": 0.08 }
  }
}
```

**How it's loaded:**

```bash
# Search for this in server.ts:
grep -n "require.*risk_controls\|riskControls\s*=" services/api/src/server.ts
```

## 3. DERIBIT INTEGRATION

### 3.1 CURRENT IMPLEMENTATION CHECK

**Step 1: Find where Deribit is used**

```bash
# Run this in terminal:
grep -rn "deribit\|orderbook\|ticker" services/api/src/server.ts | head -20

# Look for patterns like:
# - fetch("https://deribit.com/api/...")
# - fetch("https://test.deribit.com/api/...")
# - deribitClient.getOrderbook(...)
# - any URL containing "deribit"
```

**Step 2: Check current credential setup**

```bash
# Search for API keys or config loading:
grep -rn "API_KEY\|API_SECRET\|process.env.DERIBIT" services/api/src/

# Check if .env file exists:
ls -la services/api/.env

# Check if config file exists:
ls -la configs/deribit*.json
```

### 3.2 WHERE TO ADD DERIBIT TESTNET CREDENTIALS

**Option A: Environment Variables (.env file)**
If you see: `process.env.DERIBIT_API_KEY` in code

Create file: `services/api/.env`

```bash
# Deribit Testnet Credentials
DERIBIT_ENV=testnet
DERIBIT_BASE_URL=https://test.deribit.com/api/v2
DERIBIT_API_KEY=YOUR_CLIENT_ID_HERE
DERIBIT_API_SECRET=YOUR_CLIENT_SECRET_HERE
```

**Get credentials:**

1. Go to https://test.deribit.com
2. Create account
3. Account → API → Create New Key
4. Copy Client ID and Client Secret

**Option B: Config File (if using require or import for config)**
If you see: `require('./config/deribit.json')` or similar

Create file: `configs/deribit_config.json`

```json
{
  "environment": "testnet",
  "baseUrl": "https://test.deribit.com/api/v2",
  "credentials": {
    "clientId": "YOUR_CLIENT_ID_HERE",
    "clientSecret": "YOUR_CLIENT_SECRET_HERE"
  }
}
```

Add to `.gitignore`:

```bash
echo "configs/deribit_config.json" >> .gitignore
```

**Option C: Hardcoded URL Change (if no credentials used yet)**
If you see: `fetch("https://www.deribit.com/api/v2/public/...")` (public endpoints only)

Change in `server.ts`:

```typescript
// FIND:
const deribitUrl = "https://www.deribit.com/api/v2";

// CHANGE TO:
const deribitUrl = "https://test.deribit.com/api/v2";
```

No credentials needed for public endpoints (ticker, orderbook).  
Credentials needed for private endpoints (placing orders, checking balance).

### 3.3 VERIFY DERIBIT SETUP

**Quick test script - Create `services/api/test_deribit.js`:**

```javascript
// Test public endpoint (no auth needed)
const fetch = require('node-fetch');

async function test() {
  const url = "https://test.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL";
  const response = await fetch(url);
  const data = await response.json();

  if (data.result) {
    console.log('✅ Deribit testnet working');
    console.log(`BTC Price: $${data.result.last_price}`);
  } else {
    console.log('❌ Error:', data);
  }
}

test();
```

Run:

```bash
cd services/api
node test_deribit.js
```

Expected: ✅ Deribit testnet working and BTC price

## 4. POTENTIAL BLOCKS & SOLUTIONS

Issue | Symptom | Solution
---|---|---
Wrong API credentials | 401 Unauthorized error | Double-check Client ID/Secret from test.deribit.com
Mainnet vs Testnet mix | Auth works but no data | Ensure using test.deribit.com URL AND testnet credentials
Rate limiting | 429 Too Many Requests | Add 100ms delay between requests or implement rate limiter
No testnet balance | "Insufficient funds" error | Go to test.deribit.com → Account → Get Testnet BTC (free)
Instrument not found | 404 on orderbook | Check instrument name format: BTC-31DEC26-100000-C
Empty orderbook | No bid/ask prices | Testnet has less liquidity - try different strike or use public ticker only
Token expired | 401 after 15 minutes | Implement token refresh (access tokens expire)
Slow responses | 30+ seconds | Normal for first request (orderbook API latency), cache handles repeats
CORS errors | Browser console errors | Add CORS headers to server (if calling from frontend)
SSL certificate errors | Connection refused | Use https:// not http:// for Deribit URLs

## 5. TESTING CHECKLIST

**Pre-Test Setup**
```bash
# 1. Start server
cd services/api && npm start

# 2. Verify Deribit connection (if using it)
node test_deribit.js

# 3. Check logs directory exists
ls -la logs/
```

**Test 1: Basic Quote (Silver tier)**
```bash
curl -X POST http://localhost:4100/put/quote \
  -H "Content-Type: application/json" \
  -d '{
    "side": "short",
    "tierName": "Pro (Silver)",
    "asset": "BTC",
    "spotPrice": 100000,
    "fixedPriceUsdc": 100,
    "positionSize": 1.0,
    "leverage": 5,
    "drawdownFloorPct": 0.20,
    "targetDays": 7,
    "allowPremiumPassThrough": true
  }'
```

Expected:

- First request: 20-30 seconds (Deribit API)
- Second identical request: <1 second (cached)
- Response: status: "pass_through", hedgeSize: "1.0000"

**Test 2: Bronze Call Quote (allowed)**
```bash
curl -X POST http://localhost:4100/put/quote \
  -H "Content-Type: application/json" \
  -d '{
    "side": "short",
    "tierName": "Pro (Bronze)",
    "asset": "BTC",
    "spotPrice": 100000,
    "fixedPriceUsdc": 100,
    "positionSize": 1.0,
    "leverage": 2,
    "drawdownFloorPct": 0.15,
    "targetDays": 5,
    "allowPremiumPassThrough": true
  }'
```

Expected:

- Response time: <500ms (instant validation)
- Response: status "ok", "pass_through", or "premium_floor" depending on market conditions

**Test 3: Monitor Logs**
```bash
tail -f logs/audit.log
```

Look for:

- premium_pass_through events
- Any error events

## 6. QUICK REFERENCE

**File Locations**

text
services/api/src/server.ts          ← All logic (pricing, hedging, cache, validation)
configs/risk_controls.json          ← Tier caps and leverage limits
configs/deribit_config.json         ← Deribit credentials (CREATE THIS)
services/api/.env                   ← Environment variables (ALTERNATIVE)
logs/audit.log                      ← Event logging

**Key Search Commands**
```bash
# Find pricing logic:
grep -n "premium" services/api/src/server.ts

# Find hedging logic:
grep -n "subsidyUsdc" services/api/src/server.ts

# Find Deribit integration:
grep -rn "deribit" services/api/src/

# Find cache system:
grep -n "QUOTE_CACHE_TTL" services/api/src/server.ts
```

**Common Tasks**
```bash
# Start server
cd services/api && npm start

# Test Deribit
node test_deribit.js

# Watch logs
tail -f logs/audit.log

# Test quote
curl -X POST http://localhost:4100/put/quote -H "Content-Type: application/json" -d '{...}'
```

## 7. ARCHITECTURE DIAGRAM

text
┌─────────────────────────────────────────────────────────────┐
│                    USER REQUEST                             │
│         POST /put/quote { side, tier, leverage... }         │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ Cache Hit?  │
                    └──────┬──────┘
                           │
            ┌──────────────┼──────────────┐
            │ YES                         │ NO
            ▼                             ▼
    ┌──────────────┐            ┌─────────────────┐
    │ Return       │            │ Tier Validation │
    │ cached (2ms) │            │ Leverage check  │
    └──────────────┘            └────────┬────────┘
                                         │
                                    ┌────┴────┐
                                    │ REJECT? │
                                    └────┬────┘
                                         │ NO
                                         ▼
                                ┌─────────────────┐
                                │ Deribit API     │
                                │ Get orderbook   │
                                │ (20-30s)        │
                                └────────┬────────┘
                                         │
                                         ▼
                                ┌─────────────────┐
                                │ Calculate       │
                                │ Premium         │
                                └────────┬────────┘
                                         │
                                         ▼
                                ┌─────────────────┐
                                │ Calculate       │
                                │ Hedge & Subsidy │
                                └────────┬────────┘
                                         │
                                         ▼
                                ┌─────────────────┐
                                │ Cache Response  │
                                │ Return to User  │
                                └─────────────────┘

## 8. NEXT STEPS

✅ Review logic sections (1.1 - 1.4)

✅ Find Deribit integration (run grep commands in 3.1)

✅ Add testnet credentials (choose Option A, B, or C in 3.2)

✅ Test connection (run test_deribit.js from 3.3)

✅ Run quote tests (Section 5)

✅ Monitor for blocks (use table in Section 4)

If issues arise: Reference Section 4 table for quick solutions.
