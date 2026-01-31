import { describe, it, expect } from "vitest";
import { shouldRenew } from "../src/renewal";

describe("shouldRenew", () => {
  it("returns true inside renew window", () => {
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const renew = shouldRenew(new Date(), {
      expiryIso: expiry,
      renewWindowMinutes: 15
    });
    expect(renew).toBe(true);
  });
});
