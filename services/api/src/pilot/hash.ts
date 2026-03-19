import { createHmac } from "node:crypto";

const normalizeUserId = (value: string): string => value.trim().toLowerCase();

export const buildUserHash = (params: {
  rawUserId: string;
  secret: string;
  hashVersion: number;
}): { userHash: string; hashVersion: number } => {
  const normalized = normalizeUserId(params.rawUserId);
  if (!normalized) {
    throw new Error("user_id_required");
  }
  if (!params.secret) {
    throw new Error("user_hash_secret_missing");
  }
  const digest = createHmac("sha256", params.secret).update(normalized).digest("hex");
  return { userHash: digest, hashVersion: params.hashVersion };
};

export const normalizeUserIdForHash = normalizeUserId;

