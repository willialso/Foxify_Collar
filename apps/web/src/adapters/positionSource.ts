export type PositionSnapshot = {
  equityUsd: number;
  positionSizeBtc: number;
  entryPrice?: number;
  side?: "long" | "short";
  leverage?: number;
};

export type PositionSource = {
  fetchPosition: () => Promise<PositionSnapshot | null>;
};

export function createDemoPositionSource(): PositionSource {
  return {
    async fetchPosition() {
      return null;
    }
  };
}

export function createFoxifyPositionSource(endpoint: string): PositionSource {
  return {
    async fetchPosition() {
      const res = await fetch(endpoint);
      const data = await res.json();
      const equityUsd = Number(data?.equityUsd ?? data?.equity_usd ?? 0);
      const positionSizeBtc = Number(
        data?.positionSizeBtc ?? data?.position_size_btc ?? 0
      );
      const entry = Number(data?.entryPrice ?? data?.entry_price ?? 0);
      return {
        equityUsd,
        positionSizeBtc,
        entryPrice: entry || undefined,
        side: data?.side as "long" | "short" | undefined,
        leverage: Number(data?.leverage ?? 0) || undefined
      };
    }
  };
}
