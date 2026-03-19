import assert from "node:assert/strict";
import test from "node:test";
import { buildUserHash, normalizeUserIdForHash } from "../src/pilot/hash";

test("normalizeUserIdForHash trims and lowercases", () => {
  assert.equal(normalizeUserIdForHash("  USER-123  "), "user-123");
});

test("buildUserHash is deterministic for normalized user id", () => {
  const first = buildUserHash({
    rawUserId: "  User-ABC ",
    secret: "secret_v1",
    hashVersion: 1
  });
  const second = buildUserHash({
    rawUserId: "user-abc",
    secret: "secret_v1",
    hashVersion: 1
  });
  assert.equal(first.userHash, second.userHash);
  assert.equal(first.hashVersion, 1);
});

test("buildUserHash throws when secret is missing", () => {
  assert.throws(
    () =>
      buildUserHash({
        rawUserId: "user",
        secret: "",
        hashVersion: 1
      }),
    /user_hash_secret_missing/
  );
});

