import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import { resolveCoverageTargetSize } from "../src/quoteCoverage";

test("resolveCoverageTargetSize rejects strikes with zero floor intrinsic", () => {
  const target = resolveCoverageTargetSize({
    spotPrice: new Decimal(100000),
    drawdownFloorPct: new Decimal(0.2),
    optionType: "put",
    strike: new Decimal(80000),
    requiredSize: new Decimal(0.02),
    minSize: new Decimal(0.01)
  });
  assert.equal(target, null);
});

test("resolveCoverageTargetSize scales hedge size for floor-feasible put", () => {
  const target = resolveCoverageTargetSize({
    spotPrice: new Decimal(100000),
    drawdownFloorPct: new Decimal(0.2),
    optionType: "put",
    strike: new Decimal(90000),
    requiredSize: new Decimal(0.02),
    minSize: new Decimal(0.01)
  });
  assert.ok(target);
  // required credit = 400, floor intrinsic per unit = 10000 => size 0.04
  assert.equal(target?.toFixed(6), "0.040000");
});

test("resolveCoverageTargetSize enforces minimum order size", () => {
  const target = resolveCoverageTargetSize({
    spotPrice: new Decimal(100000),
    drawdownFloorPct: new Decimal(0.2),
    optionType: "put",
    strike: new Decimal(120000),
    requiredSize: new Decimal(0.02),
    minSize: new Decimal(0.03)
  });
  assert.ok(target);
  assert.equal(target?.toFixed(6), "0.030000");
});
