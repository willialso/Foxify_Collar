import Decimal from "decimal.js";
import { describe, it, expect } from "vitest";
import { estimateAverageFill } from "../src/pricing";

describe("estimateAverageFill", () => {
  it("computes average price across depth", () => {
    const book = {
      bids: [
        [99, 1],
        [98, 2]
      ],
      asks: [
        [100, 1],
        [101, 1]
      ]
    };
    const result = estimateAverageFill(book, "buy", new Decimal("1.5"));
    expect(result.avgPrice?.toFixed(6)).toBe("100.333333");
    expect(result.filledSize.toFixed(2)).toBe("1.50");
  });

  it("returns null when depth is insufficient", () => {
    const book = {
      bids: [],
      asks: [[100, 0.1]]
    };
    const result = estimateAverageFill(book, "buy", new Decimal("1"));
    expect(result.avgPrice?.toFixed(2)).toBe("100.00");
    expect(result.filledSize.toFixed(2)).toBe("0.10");
  });
});
