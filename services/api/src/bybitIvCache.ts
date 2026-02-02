import Decimal from "decimal.js";
import { getBybitAtmIv } from "./bybitAdapter";

type CacheEntry = {
  value: Decimal;
  expiresAt: number;
};

export function createBybitIvCache(options?: { ttlMs?: number; fallbackIv?: number }) {
  const ttlMs = options?.ttlMs ?? 15000;
  const fallbackIv = new Decimal(options?.fallbackIv ?? 0.5);
  const cache = new Map<string, CacheEntry>();

  async function fetchAtmIv(asset: string): Promise<Decimal> {
    const iv = await getBybitAtmIv(asset);
    if (!Number.isFinite(iv) || !iv || iv <= 0) return fallbackIv;
    return new Decimal(iv);
  }

  async function getAtmIv(asset: string): Promise<Decimal> {
    if (!asset) return fallbackIv;
    const now = Date.now();
    const cached = cache.get(asset);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    let value = fallbackIv;
    try {
      value = await fetchAtmIv(asset);
    } catch {
      value = fallbackIv;
    }
    cache.set(asset, { value, expiresAt: now + ttlMs });
    return value;
  }

  return { getAtmIv };
}
