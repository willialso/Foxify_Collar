import Decimal from "decimal.js";
import { DeribitConnector } from "@foxify/connectors";

type CacheEntry = {
  value: Decimal;
  expiresAt: number;
};

export function createDeribitIvCache(
  connector: DeribitConnector,
  options?: { ttlMs?: number; fallbackIv?: number }
) {
  const ttlMs = options?.ttlMs ?? 15000;
  const fallbackIv = new Decimal(options?.fallbackIv ?? 0.5);
  const cache = new Map<string, CacheEntry>();

  async function fetchAtmIv(asset: string): Promise<Decimal> {
    const instruments = await connector.listInstruments(asset);
    const results = (instruments as any)?.result || [];
    if (results.length === 0) return fallbackIv;

    const indexName = `${asset.toLowerCase()}_usd`;
    const spotRes = await connector.getIndexPrice(indexName);
    const spot = Number((spotRes as any)?.result?.index_price || 0);
    if (!spot) return fallbackIv;

    const now = Date.now();
    const sortedByExpiry = results
      .filter((inst: any) => inst.expiration_timestamp)
      .sort(
        (a: any, b: any) =>
          Math.abs(a.expiration_timestamp - now) - Math.abs(b.expiration_timestamp - now)
      );
    const nearestExpiry = sortedByExpiry[0]?.expiration_timestamp;
    if (!nearestExpiry) return fallbackIv;

    const candidates = results.filter((inst: any) => inst.expiration_timestamp === nearestExpiry);
    if (candidates.length === 0) return fallbackIv;

    candidates.sort(
      (a: any, b: any) => Math.abs(Number(a.strike) - spot) - Math.abs(Number(b.strike) - spot)
    );
    const chosen = candidates[0];
    if (!chosen?.instrument_name) return fallbackIv;

    const ticker = await connector.getTicker(chosen.instrument_name);
    const iv = Number((ticker as any)?.result?.mark_iv ?? 0);
    if (!Number.isFinite(iv) || iv <= 0) return fallbackIv;
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
