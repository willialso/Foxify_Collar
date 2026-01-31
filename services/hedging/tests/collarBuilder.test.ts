import Decimal from "decimal.js";
import { describe, it, expect } from "vitest";
import { buildFixedPriceOption } from "../src/collarBuilder";

describe("buildFixedPriceOption", () => {
  it("selects a put within fixed price", () => {
    const quote = buildFixedPriceOption({
      spotPrice: new Decimal("50000"),
      drawdownFloorPct: new Decimal("0.2"),
      fixedPriceUsdc: new Decimal("25"),
      side: "put",
      options: [
        { strike: new Decimal("40000"), mid: new Decimal("30") },
        { strike: new Decimal("42000"), mid: new Decimal("20") }
      ]
    });

    expect(quote).not.toBeNull();
    expect(quote?.premiumUsdc.toFixed(2)).toBe("20.00");
  });

  it("selects a call within fixed price", () => {
    const quote = buildFixedPriceOption({
      spotPrice: new Decimal("50000"),
      drawdownFloorPct: new Decimal("0.2"),
      fixedPriceUsdc: new Decimal("25"),
      side: "call",
      options: [
        { strike: new Decimal("60000"), mid: new Decimal("10") },
        { strike: new Decimal("62000"), mid: new Decimal("15") }
      ]
    });

    expect(quote).not.toBeNull();
    expect(quote?.premiumUsdc.toFixed(2)).toBe("10.00");
  });

  it("prefers liquidity when size is constrained", () => {
    const quote = buildFixedPriceOption({
      spotPrice: new Decimal("50000"),
      drawdownFloorPct: new Decimal("0.2"),
      fixedPriceUsdc: new Decimal("25"),
      side: "put",
      requiredSize: new Decimal("0.5"),
      maxSpreadPct: new Decimal("0.05"),
      options: [
        {
          strike: new Decimal("42000"),
          mid: new Decimal("18"),
          askSize: new Decimal("0.05"),
          spreadPct: new Decimal("0.01")
        },
        {
          strike: new Decimal("42000"),
          mid: new Decimal("20"),
          askSize: new Decimal("1.0"),
          spreadPct: new Decimal("0.02")
        }
      ]
    });

    expect(quote).not.toBeNull();
    expect(quote?.premiumUsdc.toFixed(2)).toBe("10.00");
  });
});
