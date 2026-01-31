import Decimal from "decimal.js";
import { describe, it, expect } from "vitest";
import { computeRiskSummary } from "../src/riskEngine";
import { hedgeSizeFromNotional, hedgeSizeFromDelta } from "../src/positionSizing";

describe("computeRiskSummary", () => {
  it("calculates drawdown buffer", () => {
    const summary = computeRiskSummary(
      {
        cashUsdc: new Decimal("10000"),
        positionPnlUsdc: new Decimal("-500"),
        hedgeMtmUsdc: new Decimal("200"),
        drawdownLimitUsdc: new Decimal("9000")
      },
      new Decimal("10000")
    );

    expect(summary.equityUsdc.toFixed(2)).toBe("9700.00");
    expect(summary.drawdownBufferUsdc.toFixed(2)).toBe("700.00");
  });

  it("sizes hedge by notional", () => {
    const hedge = hedgeSizeFromNotional(new Decimal("2"), new Decimal("1"));
    expect(hedge.toFixed(2)).toBe("2.00");
  });

  it("sizes hedge by delta", () => {
    const hedge = hedgeSizeFromDelta(new Decimal("1"), new Decimal("0.5"));
    expect(hedge.toFixed(2)).toBe("2.00");
  });
});
