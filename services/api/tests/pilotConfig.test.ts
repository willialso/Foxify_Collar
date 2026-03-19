import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDeribitQuotePolicy,
  parseDeribitStrikeSelectionMode,
  parsePilotVenueMode,
  resolvePilotWindow
} from "../src/pilot/config";

test("parsePilotVenueMode accepts known values", () => {
  assert.equal(parsePilotVenueMode("falconx"), "falconx");
  assert.equal(parsePilotVenueMode("deribit_test"), "deribit_test");
  assert.equal(parsePilotVenueMode("mock_falconx"), "mock_falconx");
  assert.equal(parsePilotVenueMode(undefined), "deribit_test");
});

test("parsePilotVenueMode fails fast on unknown values", () => {
  assert.throws(() => parsePilotVenueMode("unknown_mode"), /invalid_pilot_venue_mode/);
});

test("parseDeribitQuotePolicy accepts known values", () => {
  assert.equal(parseDeribitQuotePolicy("ask_only"), "ask_only");
  assert.equal(parseDeribitQuotePolicy("ask_or_mark_fallback"), "ask_or_mark_fallback");
  assert.equal(parseDeribitQuotePolicy(undefined), "ask_or_mark_fallback");
});

test("parseDeribitQuotePolicy fails fast on unknown values", () => {
  assert.throws(() => parseDeribitQuotePolicy("invalid"), /invalid_deribit_quote_policy/);
});

test("parseDeribitStrikeSelectionMode accepts known values", () => {
  assert.equal(parseDeribitStrikeSelectionMode("legacy"), "legacy");
  assert.equal(parseDeribitStrikeSelectionMode("trigger_aligned"), "trigger_aligned");
  assert.equal(parseDeribitStrikeSelectionMode(undefined), "legacy");
});

test("parseDeribitStrikeSelectionMode fails fast on unknown values", () => {
  assert.throws(
    () => parseDeribitStrikeSelectionMode("invalid"),
    /invalid_deribit_strike_selection_mode/
  );
});

test("resolvePilotWindow supports optional start and hard-stop duration", () => {
  const prevStart = process.env.PILOT_START_AT;
  const prevDuration = process.env.PILOT_DURATION_DAYS;
  const prevEnforce = process.env.PILOT_ENFORCE_WINDOW;
  try {
    process.env.PILOT_ENFORCE_WINDOW = "true";
    process.env.PILOT_DURATION_DAYS = "30";
    process.env.PILOT_START_AT = "";
    assert.equal(resolvePilotWindow(new Date()).status, "open");

    process.env.PILOT_START_AT = "not-a-date";
    assert.equal(resolvePilotWindow(new Date()).status, "config_invalid");

    const now = Date.now();
    process.env.PILOT_START_AT = new Date(now + 86400000).toISOString();
    assert.equal(resolvePilotWindow(new Date(now)).status, "not_started");

    process.env.PILOT_START_AT = new Date(now - 31 * 86400000).toISOString();
    assert.equal(resolvePilotWindow(new Date(now)).status, "closed");
  } finally {
    process.env.PILOT_START_AT = prevStart;
    process.env.PILOT_DURATION_DAYS = prevDuration;
    process.env.PILOT_ENFORCE_WINDOW = prevEnforce;
  }
});

