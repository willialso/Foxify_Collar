import assert from "node:assert/strict";
import test from "node:test";
import type { RiskControlsConfig } from "../src/riskControls";
import { resolvePremiumMarkupPctForQuote } from "../src/markupProfile";

test("uses VC demo markup profile when vc_demo_override_enabled is true", () => {
  const controls = {
    vc_demo_override_enabled: true,
    vc_demo_override_premium_markup_pct_by_tier: {
      "Pro (Bronze)": 0.005,
      "Pro (Silver)": 0.015
    },
    vc_demo_override_leverage_markup_pct_by_x: {
      "1": 0,
      "5": 0.01
    },
    premium_markup_pct_by_tier: {
      "Pro (Silver)": 0.03
    },
    leverage_markup_pct_by_x: {
      "5": 0.02
    }
  } as RiskControlsConfig;

  const pct = resolvePremiumMarkupPctForQuote("Pro (Silver)", 5, controls);
  assert.equal(pct.toFixed(4), "0.0250");
});

test("preserves production behavior when VC override is disabled", () => {
  const controls = {
    vc_demo_override_enabled: false,
    premium_markup_pct_by_tier: {
      "Pro (Bronze)": 0.02,
      "Pro (Silver)": 0.03
    },
    leverage_markup_pct_by_x: {
      "1": 0,
      "5": 0.02
    }
  } as RiskControlsConfig;

  const bronzePct = resolvePremiumMarkupPctForQuote("Pro (Bronze)", 5, controls);
  const silverPct = resolvePremiumMarkupPctForQuote("Pro (Silver)", 5, controls);
  assert.equal(bronzePct.toFixed(4), "0.0000");
  assert.equal(silverPct.toFixed(4), "0.0500");
});

test("falls back to standard markup maps when VC maps are not configured", () => {
  const controls = {
    vc_demo_override_enabled: true,
    premium_markup_pct_by_tier: {
      "Pro (Gold)": 0.04
    },
    leverage_markup_pct_by_x: {
      "3": 0.01
    }
  } as RiskControlsConfig;

  const pct = resolvePremiumMarkupPctForQuote("Pro (Gold)", 3, controls);
  assert.equal(pct.toFixed(4), "0.0500");
});
