import assert from "node:assert/strict";
import test from "node:test";
import { buildCoverageReport } from "../src/coverageReport";

test("buildCoverageReport uses ledger state for exact position matches", () => {
  const report = buildCoverageReport({
    accountId: "demo",
    positions: [
      {
        asset: "BTC",
        side: "long",
        entryPrice: 100000,
        size: 1,
        leverage: 2
      }
    ],
    coverageLedgerEntries: [
      {
        coverageId: "cov-demo-1",
        accountId: "demo",
        positions: [
          {
            id: "p1",
            asset: "BTC",
            side: "long",
            marginUsd: 50000,
            leverage: 2,
            entryPrice: 100000
          }
        ],
        hedgeInstrument: "BTC-27FEB26-90000-P",
        hedgeSize: 1.02,
        optionType: "put",
        strike: 90000,
        pricingReason: "base_markup",
        quotedFeeUsdc: 1100,
        hedgeSpendUsdc: 900,
        floorUsd: 85000,
        equityUsd: 100000
      },
      {
        coverageId: "cov-other",
        accountId: "other",
        positions: [
          {
            id: "p2",
            asset: "BTC",
            side: "long",
            marginUsd: 50000,
            leverage: 2,
            entryPrice: 100000
          }
        ],
        hedgeInstrument: "BTC-27FEB26-80000-P",
        hedgeSize: 0.1
      }
    ]
  });

  assert.equal(report.results.length, 1);
  assert.equal(report.covered, 1);
  assert.equal(report.coveragePct, "100.00");
  assert.equal(report.results[0]?.coverageId, "cov-demo-1");
  assert.equal(report.results[0]?.hedgeInstrument, "BTC-27FEB26-90000-P");
  assert.equal(report.results[0]?.expiryTag, "27FEB26");
  assert.equal(report.results[0]?.feeUsd, 1100);
  assert.equal(report.results[0]?.premiumUsd, 900);
  assert.equal(report.results[0]?.subsidyUsd, 0);
  assert.equal(report.results[0]?.isCovered, true);
});

test("buildCoverageReport falls back to nearest-size candidate for same asset/side", () => {
  const report = buildCoverageReport({
    accountId: "demo",
    positions: [
      {
        asset: "ETH",
        side: "short",
        entryPrice: 4000,
        size: 2,
        leverage: 4
      }
    ],
    coverageLedgerEntries: [
      {
        coverageId: "cov-far",
        accountId: "demo",
        positions: [
          {
            id: "eth-far",
            asset: "ETH",
            side: "short",
            marginUsd: 4000,
            leverage: 2,
            entryPrice: 4000
          }
        ],
        hedgeInstrument: "ETH-27FEB26-4200-C",
        hedgeSize: 0.5
      },
      {
        coverageId: "cov-near",
        accountId: "demo",
        positions: [
          {
            id: "eth-near",
            asset: "ETH",
            side: "short",
            marginUsd: 2200,
            leverage: 4,
            entryPrice: 4000
          }
        ],
        hedgeInstrument: "ETH-27FEB26-4200-C",
        hedgeSize: 1.95
      }
    ]
  });

  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]?.coverageId, "cov-near");
  assert.equal(report.results[0]?.coveredSize, 1.95);
  assert.equal(report.results[0]?.coveragePct, "97.50");
  assert.equal(report.results[0]?.isCovered, false);
});

test("buildCoverageReport uses coverage legs as canonical hedge size", () => {
  const report = buildCoverageReport({
    accountId: "demo",
    positions: [
      {
        asset: "BTC",
        side: "long",
        entryPrice: 100000,
        size: 1,
        leverage: 1
      }
    ],
    coverageLedgerEntries: [
      {
        coverageId: "cov-legs",
        accountId: "demo",
        positions: [
          {
            id: "p3",
            asset: "BTC",
            side: "long",
            marginUsd: 100000,
            leverage: 1,
            entryPrice: 100000
          }
        ],
        hedgeInstrument: "BTC-27FEB26-85000-P",
        hedgeSize: 0.2,
        coverageLegs: [
          { instrument: "BTC-27FEB26-85000-P", size: 0.7 },
          { instrument: "BTC-27FEB26-82000-P", size: 0.35 }
        ]
      }
    ]
  });

  assert.ok(Math.abs((report.results[0]?.coveredSize ?? 0) - 1.05) < 1e-9);
  assert.equal(report.results[0]?.isCovered, true);
});

test("buildCoverageReport does not borrow explicit coverage from other accounts", () => {
  const report = buildCoverageReport({
    accountId: "demo",
    positions: [
      {
        asset: "BTC",
        side: "long",
        entryPrice: 90000,
        size: 1,
        leverage: 1
      }
    ],
    coverageLedgerEntries: [
      {
        coverageId: "cov-other-account",
        accountId: "other",
        positions: [
          {
            id: "p4",
            asset: "BTC",
            side: "long",
            marginUsd: 90000,
            leverage: 1,
            entryPrice: 90000
          }
        ],
        hedgeSize: 1
      }
    ]
  });

  assert.equal(report.results[0]?.coverageId, null);
  assert.equal(report.results[0]?.coveredSize, 0);
  assert.equal(report.results[0]?.isCovered, false);
});
