import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  computeTriggerPrice,
  computeFloorPrice,
  computePayoutDue,
  normalizeProtectionType,
  normalizeTierName,
  resolveDrawdownFloorPct,
  resolveExpiryDays,
  resolveRenewWindowMinutes
} from "../src/pilot/floor";

test("normalizeTierName falls back to Bronze for unknown tier", () => {
  assert.equal(normalizeTierName("Unknown"), "Pro (Bronze)");
  assert.equal(normalizeTierName("Pro (Gold)"), "Pro (Gold)");
});

test("resolveDrawdownFloorPct uses provided valid value else tier default", () => {
  assert.equal(resolveDrawdownFloorPct({ tierName: "Pro (Silver)" }).toFixed(2), "0.15");
  assert.equal(
    resolveDrawdownFloorPct({ tierName: "Pro (Silver)", drawdownFloorPct: 0.11 }).toFixed(2),
    "0.11"
  );
});

test("resolveExpiryDays is fixed to tier default and renew window remains bounded", () => {
  assert.equal(resolveExpiryDays({ tierName: "Pro (Bronze)", requestedDays: 9 }), 7);
  assert.equal(resolveExpiryDays({ tierName: "Pro (Bronze)", requestedDays: 0 }), 7);
  assert.equal(resolveRenewWindowMinutes({ tierName: "Pro (Gold)", requestedMinutes: 240 }), 240);
});

test("computeFloorPrice and payout respect floor threshold", () => {
  const entry = new Decimal(100000);
  const drawdown = new Decimal(0.2);
  const floor = computeFloorPrice(entry, drawdown);
  assert.equal(floor.toFixed(0), "80000");

  const noPayout = computePayoutDue({
    protectedNotional: new Decimal(10000),
    entryPrice: entry,
    triggerPrice: floor,
    expiryPrice: new Decimal(85000),
    protectionType: "long"
  });
  assert.equal(noPayout.toFixed(2), "0.00");

  const payout = computePayoutDue({
    protectedNotional: new Decimal(10000),
    entryPrice: entry,
    triggerPrice: floor,
    expiryPrice: new Decimal(70000),
    protectionType: "long"
  });
  assert.equal(payout.toFixed(2), "1000.00");
});

test("computeTriggerPrice and payout support short protection type", () => {
  const entry = new Decimal(100000);
  const adverseMove = new Decimal(0.2);
  const trigger = computeTriggerPrice(entry, adverseMove, "short");
  assert.equal(trigger.toFixed(0), "120000");

  const noPayout = computePayoutDue({
    protectedNotional: new Decimal(10000),
    entryPrice: entry,
    triggerPrice: trigger,
    expiryPrice: new Decimal(115000),
    protectionType: "short"
  });
  assert.equal(noPayout.toFixed(2), "0.00");

  const payout = computePayoutDue({
    protectedNotional: new Decimal(10000),
    entryPrice: entry,
    triggerPrice: trigger,
    expiryPrice: new Decimal(130000),
    protectionType: "short"
  });
  assert.equal(payout.toFixed(2), "1000.00");
});

test("normalizeProtectionType defaults to long", () => {
  assert.equal(normalizeProtectionType("short"), "short");
  assert.equal(normalizeProtectionType("LONG"), "long");
  assert.equal(normalizeProtectionType(undefined), "long");
});

