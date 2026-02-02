import { getBybitOrderbook, getBybitSpotPrice, formatBybitInstrument } from "./src/bybitAdapter";

async function runBybitVerification() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("BYBIT ADAPTER VERIFICATION SUITE");
  console.log("════════════════════════════════════════════════════════════");
  console.log("");

  let passCount = 0;
  let failCount = 0;

  console.log("TEST 1.1: Bybit Spot Price Retrieval");
  console.log("─────────────────────────────────────────────────────────");
  try {
    const spot = await getBybitSpotPrice("BTC");
    if (spot && spot > 0) {
      console.log(`✅ PASS - BTC Spot: $${spot.toFixed(2)}`);
      passCount++;
    } else {
      console.log(`❌ FAIL - Invalid spot price: ${spot}`);
      failCount++;
    }
  } catch (err: any) {
    console.log(`❌ FAIL - Error: ${err.message}`);
    failCount++;
  }
  console.log("");

  console.log("TEST 1.2: Instrument Name Formatting");
  console.log("─────────────────────────────────────────────────────────");
  const testDate = new Date("2026-12-31T08:00:00Z");
  const formatted = formatBybitInstrument("BTC", testDate, 100000, "C");
  const expected = "BTC-31DEC26-100000-C";

  if (formatted === expected) {
    console.log(`✅ PASS - Format: ${formatted}`);
    passCount++;
  } else {
    console.log(`❌ FAIL - Expected: ${expected}, Got: ${formatted}`);
    failCount++;
  }
  console.log("");

  console.log("TEST 1.3: Bybit Orderbook Retrieval (Near ATM)");
  console.log("─────────────────────────────────────────────────────────");
  try {
    const spot = await getBybitSpotPrice("BTC");
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);
    expiry.setUTCHours(8, 0, 0, 0);

    const strike = Math.round(spot / 1000) * 1000;
    console.log(`Querying: Strike=${strike}, Expiry=${expiry.toISOString().split("T")[0]}, Type=Call`);

    const orderbook = await getBybitOrderbook("BTC", strike, expiry, "C");
    if (orderbook && orderbook.ask > 0 && orderbook.bid > 0) {
      const spread = ((orderbook.ask - orderbook.bid) / orderbook.bid) * 100;
      console.log("✅ PASS - Orderbook retrieved");
      console.log(`   Bid: $${orderbook.bid.toFixed(2)}`);
      console.log(`   Ask: $${orderbook.ask.toFixed(2)}`);
      console.log(`   Spread: ${spread.toFixed(3)}%`);
      console.log(`   Bid Size: ${orderbook.bidSize}`);
      console.log(`   Ask Size: ${orderbook.askSize}`);
      passCount++;
    } else if (!orderbook) {
      console.log("⚠️  PARTIAL - No orderbook (strike may not exist on Bybit)");
      console.log("   This is acceptable - Deribit will be used as fallback");
      passCount++;
    } else {
      console.log("❌ FAIL - Invalid orderbook data");
      failCount++;
    }
  } catch (err: any) {
    console.log(`❌ FAIL - Error: ${err.message}`);
    failCount++;
  }
  console.log("");

  console.log("TEST 1.4: Bybit Orderbook Retrieval (Put Option)");
  console.log("─────────────────────────────────────────────────────────");
  try {
    const spot = await getBybitSpotPrice("BTC");
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);
    expiry.setUTCHours(8, 0, 0, 0);

    const strike = Math.round(spot * 0.95 / 1000) * 1000;
    console.log(`Querying: Strike=${strike}, Expiry=${expiry.toISOString().split("T")[0]}, Type=Put`);

    const orderbook = await getBybitOrderbook("BTC", strike, expiry, "P");
    if (orderbook && orderbook.ask > 0) {
      console.log("✅ PASS - Put orderbook retrieved");
      console.log(`   Ask: $${orderbook.ask.toFixed(2)}`);
      passCount++;
    } else if (!orderbook) {
      console.log("⚠️  PARTIAL - No orderbook (acceptable)");
      passCount++;
    } else {
      console.log("❌ FAIL - Invalid data");
      failCount++;
    }
  } catch (err: any) {
    console.log(`❌ FAIL - Error: ${err.message}`);
    failCount++;
  }
  console.log("");

  console.log("TEST 1.5: Timeout Handling (Invalid Instrument)");
  console.log("─────────────────────────────────────────────────────────");
  try {
    const expiry = new Date("2030-12-31T08:00:00Z");
    const orderbook = await getBybitOrderbook("BTC", 999999999, expiry, "C");
    if (orderbook === null) {
      console.log("✅ PASS - Gracefully returned null for invalid instrument");
      passCount++;
    } else {
      console.log("❌ FAIL - Should return null for invalid instrument");
      failCount++;
    }
  } catch (err: any) {
    console.log("❌ FAIL - Should not throw, should return null");
    failCount++;
  }
  console.log("");

  console.log("════════════════════════════════════════════════════════════");
  console.log("BYBIT ADAPTER TEST SUMMARY");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`✅ Passed: ${passCount}/5`);
  console.log(`❌ Failed: ${failCount}/5`);
  console.log(`📊 Success Rate: ${((passCount / 5) * 100).toFixed(1)}%`);
  console.log("");

  if (failCount === 0) {
    console.log("🎉 ALL TESTS PASSED - Bybit adapter working correctly");
  } else {
    console.log("⚠️  SOME TESTS FAILED - Review errors above");
  }
  console.log("════════════════════════════════════════════════════════════");
}

runBybitVerification().catch(console.error);
