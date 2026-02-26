import assert from "node:assert/strict";
import test from "node:test";
import Decimal from "decimal.js";
import {
  isQuoteAmountWithinTolerance,
  isSurvivalSatisfied,
  resolveLiveCtcFeeControl
} from "../src/phase0Guards";

test("CTC fee control remains disabled in shadow mode", () => {
  assert.equal(resolveLiveCtcFeeControl({ ctc_enabled: true, ctc_shadow_mode: true }), false);
  assert.equal(resolveLiveCtcFeeControl({ ctc_enabled: true, ctc_shadow_mode: false }), true);
  assert.equal(resolveLiveCtcFeeControl({ ctc_enabled: false, ctc_shadow_mode: false }), false);
});

test("quote amount tolerance accepts slight execution drift", () => {
  const result = isQuoteAmountWithinTolerance({
    quotedSize: new Decimal("1.0000"),
    requestedSize: new Decimal("1.0150"),
    tolerancePct: 0.02,
    toleranceAbs: 0.001
  });
  assert.equal(result.ok, true);
  assert.ok(result.maxAllowed);
});

test("quote amount tolerance rejects oversize requests", () => {
  const result = isQuoteAmountWithinTolerance({
    quotedSize: new Decimal("1.0000"),
    requestedSize: new Decimal("1.0500"),
    tolerancePct: 0.02,
    toleranceAbs: 0.001
  });
  assert.equal(result.ok, false);
  assert.ok(result.maxAllowed);
  assert.equal(result.maxAllowed?.toFixed(3), "1.021");
});

test("survival checks must explicitly pass", () => {
  assert.equal(isSurvivalSatisfied(null), false);
  assert.equal(isSurvivalSatisfied({ pass: false }), false);
  assert.equal(isSurvivalSatisfied({ pass: true }), true);
});
