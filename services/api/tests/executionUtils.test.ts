import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveOptionPremiumUsdc,
  simulateTopOfBookPaperFill
} from "../src/executionUtils";

test("simulateTopOfBookPaperFill returns full fill when depth is sufficient", () => {
  const result = simulateTopOfBookPaperFill({
    side: "buy",
    amount: 1,
    bestBid: 98,
    bestAsk: 100,
    bidSize: 2,
    askSize: 3,
    fillCurrency: "usdt"
  });
  assert.equal(result.status, "paper_filled");
  assert.equal(result.reason, "full_fill");
  assert.equal(result.filledAmount, 1);
  assert.equal(result.fillPrice, 100);
});

test("simulateTopOfBookPaperFill returns partial fill when depth is insufficient", () => {
  const result = simulateTopOfBookPaperFill({
    side: "buy",
    amount: 2,
    bestBid: 98,
    bestAsk: 100,
    bidSize: 2,
    askSize: 0.4,
    fillCurrency: "usdt"
  });
  assert.equal(result.status, "paper_filled");
  assert.equal(result.reason, "partial_fill");
  assert.equal(result.filledAmount, 0.4);
  assert.equal(result.fillPrice, 100);
});

test("simulateTopOfBookPaperFill rejects when top-of-book is missing", () => {
  const result = simulateTopOfBookPaperFill({
    side: "sell",
    amount: 1,
    bestBid: null,
    bestAsk: 100,
    bidSize: 0,
    askSize: 2
  });
  assert.equal(result.status, "paper_rejected");
  assert.equal(result.reason, "no_top_of_book");
});

test("resolveOptionPremiumUsdc uses quote currency for Bybit", () => {
  const premium = resolveOptionPremiumUsdc({
    fillPrice: 120,
    filledAmount: 0.5,
    spotPrice: null,
    isBybitExecution: true
  });
  assert.equal(premium, 60);
});

test("resolveOptionPremiumUsdc converts Deribit option premium with spot", () => {
  const premium = resolveOptionPremiumUsdc({
    fillPrice: 0.02,
    filledAmount: 0.5,
    spotPrice: 100000,
    isBybitExecution: false
  });
  assert.equal(premium, 1000);
});

test("resolveOptionPremiumUsdc rejects missing spot for Deribit", () => {
  const premium = resolveOptionPremiumUsdc({
    fillPrice: 0.02,
    filledAmount: 1,
    spotPrice: null,
    isBybitExecution: false
  });
  assert.equal(premium, null);
});
