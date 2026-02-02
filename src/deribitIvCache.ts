import { DeribitConnector } from "@foxify/connectors";
import Decimal from "decimal.js";

export type IvCacheOptions = {
  ttlMs: number;
  fallbackIv: number;
};

type CacheEntry = {
  iv: number;
  ts: number;
};

export function createDeribitIvCache(
  connector: DeribitConnector,
  options?: Partial<IvCacheOptions>
) {
  const ttlMs = options?.ttlMs ?? 15000;
  const fallbackIv = options?.fallbackIv ?? 0.5;

  const cache = new Map<string, CacheEntry>();

  async function getAtmIv(asset: string): Promise<Decimal> {
    const cached = cache.get(asset);
    const now = Date.now();

    if (cached && now - cached.ts < ttlMs) {
      return new Decimal(cached.iv);
    }

    try {
      const instruments = await connector.listInstruments(asset);
      const result = (instruments as any)?.result || [];
      const indexPrice = await connector.getIndexPrice(`${asset.toLowerCase()}_usd`);
      const spot = Number((indexPrice as any)?.result?.index_price ?? 0);

      if (!spot || spot <= 0) {
        throw new Error("Invalid spot price");
      }

      const puts = result.filter(
        (inst: any) =>
          inst.option_type === "put" &&
          inst.expiration_timestamp > now &&
          inst.expiration_timestamp < now + 7 * 24 * 60 * 60 * 1000
      );

      if (!puts.length) {
        throw new Error("No suitable options found");
      }

      let atmInstrument = puts[0];
      let minDiff = Math.abs(Number(puts[0].strike || 0) - spot);

      for (const inst of puts) {
        const diff = Math.abs(Number(inst.strike || 0) - spot);
        if (diff < minDiff) {
          minDiff = diff;
          atmInstrument = inst;
        }
      }

      const ticker = await connector.getTicker(atmInstrument.instrument_name);
      const tickerData = (ticker as any)?.result;
      const iv = Number(tickerData?.mark_iv ?? fallbackIv);

      if (!Number.isFinite(iv) || iv <= 0) {
        throw new Error("Invalid IV value");
      }

      cache.set(asset, { iv, ts: now });
      return new Decimal(iv);
    } catch (error) {
      console.warn(`IV cache error for ${asset}, using fallback:`, error);
      cache.set(asset, { iv: fallbackIv, ts: now });
      return new Decimal(fallbackIv);
    }
  }

  return { getAtmIv };
}
