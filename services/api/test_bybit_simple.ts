import { getBybitOrderbook, getBybitSpotPrice } from "./src/bybitAdapter";

async function testBybit() {
  console.log("Testing Bybit adapter with VPN...\n");

  console.log("TEST 1: Spot Price");
  console.log("─────────────────────────────────────────");
  const spot = await getBybitSpotPrice("BTC");

  if (spot && spot > 0) {
    console.log(`✅ PASS - BTC: $${spot}\n`);
  } else {
    console.log("❌ FAIL - Check VPN connection to Singapore\n");
    console.log("Run: nordvpn status");
    console.log("Run: curl https://api.bybit.com/v5/market/time\n");
    return;
  }

  console.log("TEST 2: Options Orderbook");
  console.log("─────────────────────────────────────────");

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 7);
  expiry.setUTCHours(8, 0, 0, 0);

  const strike = Math.round(spot / 1000) * 1000;
  console.log(`Querying: ${strike} call, expiry ${expiry.toISOString().split("T")[0]}\n`);

  const orderbook = await getBybitOrderbook("BTC", strike, expiry, "C");

  if (orderbook) {
    console.log("✅ PASS - Orderbook retrieved");
    console.log(`   Ask: $${orderbook.ask}`);
    console.log(`   Bid: $${orderbook.bid}`);
    console.log(`   Spread: ${orderbook.spread.toFixed(2)}%\n`);
    console.log("🎉 Bybit integration working! Ready for dual-venue pricing.\n");
  } else {
    console.log("⚠️  No orderbook for this strike (may not exist)");
    console.log("   This is normal - try different strike or expiry");
    console.log("   If all strikes fail, check VPN connection\n");
  }
}

testBybit();
