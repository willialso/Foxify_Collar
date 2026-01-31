import WebSocket from "ws";
import { DeribitConnector } from "@foxify/connectors";

type LadderLeg = {
  tenorDays: number;
  floorPct: number;
  instrument: string;
  strike: number;
};

type LadderSnapshot = {
  baseIv: number;
  hedgeIv: number;
  ts: number;
  instruments: string[];
  legs: Array<
    LadderLeg & { markIv: number | null; markPrice: number | null }
  >;
  spot: number;
};

type LadderOptions = {
  asset: string;
  expiriesDays: number[];
  floorPcts: number[];
  refreshMs?: number;
  maxAgeMs?: number;
  maxSnapshotAgeMs?: number;
  wsUrl?: string;
  priceBufferPct?: number;
};

type IvEntry = {
  markIv: number;
  markPrice: number;
  askPrice: number;
  bidPrice: number;
  bidIv?: number;
  askIv?: number;
  ts: number;
};

export function createDeribitIvLadderCache(
  connector: DeribitConnector,
  options: LadderOptions
) {
  const asset = options.asset.toUpperCase();
  const expiriesDays = options.expiriesDays;
  const floorPcts = options.floorPcts;
  const refreshMs = options.refreshMs ?? 300000;
  const maxAgeMs = options.maxAgeMs ?? 5000;
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? 10000;
  const wsUrl = options.wsUrl ?? "wss://www.deribit.com/ws/api/v2";
  const priceBufferPct = options.priceBufferPct ?? 0.0;

  let ws: WebSocket | null = null;
  let ladderInstruments: string[] = [];
  let ladderLegs: LadderLeg[] = [];
  const ivByInstrument = new Map<string, IvEntry>();
  let lastSnapshot: LadderSnapshot | null = null;
  let lastSpot = 0;
  let refreshTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const nowMs = () => Date.now();

  const send = (payload: Record<string, unknown>) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  const subscribe = (channels: string[]) => {
    if (!channels.length) return;
    send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "public/subscribe",
      params: { channels: channels.map((channel) => `${channel}.100ms`) }
    });
  };

  const unsubscribe = (channels: string[]) => {
    if (!channels.length) return;
    send({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "public/unsubscribe",
      params: { channels: channels.map((channel) => `${channel}.100ms`) }
    });
  };

  const updateSubscriptions = (nextLegs: LadderLeg[]) => {
    const next = nextLegs.map((leg) => leg.instrument);
    const prevSet = new Set(ladderInstruments);
    const nextSet = new Set(next);
    const add = next.filter((item) => !prevSet.has(item));
    const remove = ladderInstruments.filter((item) => !nextSet.has(item));
    ladderInstruments = next;
    ladderLegs = nextLegs;
    subscribe(add.map((item) => `ticker.${item}`));
    unsubscribe(remove.map((item) => `ticker.${item}`));
  };

  const buildLadder = async (): Promise<LadderLeg[]> => {
    const instruments = await connector.listInstruments(asset);
    const results = (instruments as any)?.result || [];
    if (!results.length) return [];

    const indexName = `${asset.toLowerCase()}_usd`;
    const spotRes = await connector.getIndexPrice(indexName);
    const spot = Number((spotRes as any)?.result?.index_price || 0);
    if (!spot) return [];
    lastSpot = spot;

    const puts = results.filter((inst: any) => inst.option_type === "put" && inst.expiration_timestamp);
    if (!puts.length) return [];

    const now = Date.now();
    const byExpiry: Record<string, Array<any>> = {};
    for (const inst of puts) {
      const tag = String(inst.instrument_name || "").split("-")[1] || "";
      if (!tag) continue;
      if (!byExpiry[tag]) byExpiry[tag] = [];
      byExpiry[tag].push(inst);
    }

    const expiryTags = expiriesDays
      .map((days) => {
        const targetMs = now + days * 24 * 60 * 60 * 1000;
        let bestTag = "";
        let bestDiff = Number.POSITIVE_INFINITY;
        for (const inst of puts) {
          const diff = Math.abs(inst.expiration_timestamp - targetMs);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestTag = String(inst.instrument_name || "").split("-")[1] || "";
          }
        }
        return bestTag;
      })
      .filter((tag) => tag);

    const legs: LadderLeg[] = [];
    for (const tag of expiryTags) {
      const pool = byExpiry[tag] || [];
      if (!pool.length) continue;
      const tenorDays = Math.max(
        1,
        Math.round(
          (pool[0].expiration_timestamp - now) / (24 * 60 * 60 * 1000)
        )
      );
      for (const floor of floorPcts) {
        const targetStrike = spot * (1 - floor);
        let bestAbove: any | null = null;
        let bestAboveDiff = Number.POSITIVE_INFINITY;
        let bestAny = pool[0];
        let bestAnyDiff = Math.abs(Number(pool[0].strike) - targetStrike);
        for (const inst of pool) {
          const diff = Math.abs(Number(inst.strike) - targetStrike);
          if (diff < bestAnyDiff) {
            bestAny = inst;
            bestAnyDiff = diff;
          }
          if (Number(inst.strike) >= targetStrike && diff < bestAboveDiff) {
            bestAbove = inst;
            bestAboveDiff = diff;
          }
        }
        const chosen = bestAbove ?? bestAny;
        if (chosen?.instrument_name) {
          legs.push({
            tenorDays,
            floorPct: floor,
            instrument: chosen.instrument_name,
            strike: Number(chosen.strike)
          });
        }
      }
    }
    const unique = new Map<string, LadderLeg>();
    for (const leg of legs) {
      unique.set(leg.instrument, leg);
    }
    return Array.from(unique.values());
  };

  const refreshLadder = async () => {
    try {
      const next = await buildLadder();
      updateSubscriptions(next);
    } catch {
      // ignore refresh errors
    }
  };

  const connect = () => {
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
    ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      if (ladderInstruments.length) {
        subscribe(ladderInstruments.map((item) => `ticker.${item}`));
      }
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.method !== "subscription") return;
        const channel = msg?.params?.channel || "";
        if (!String(channel).startsWith("ticker.")) return;
        const raw = String(channel).slice("ticker.".length);
        const instrument = raw.replace(/\.100ms$/, "");
        const payload = msg?.params?.data || {};
        const markIv = Number(payload?.mark_iv ?? 0);
        const markPrice = Number(payload?.mark_price ?? payload?.mark_price_usd ?? 0);
        const bidPrice = Number(payload?.best_bid_price ?? payload?.bid_price ?? 0);
        const askPrice = Number(payload?.best_ask_price ?? payload?.ask_price ?? 0);
        const bidIv = Number(payload?.bid_iv ?? 0);
        const askIv = Number(payload?.ask_iv ?? 0);
        if (!Number.isFinite(markIv) || markIv <= 0) return;
        if (!Number.isFinite(markPrice) || markPrice <= 0) return;
        ivByInstrument.set(instrument, {
          markIv,
          markPrice,
          bidPrice: Number.isFinite(bidPrice) ? bidPrice : 0,
          askPrice: Number.isFinite(askPrice) ? askPrice : 0,
          bidIv: Number.isFinite(bidIv) ? bidIv : undefined,
          askIv: Number.isFinite(askIv) ? askIv : undefined,
          ts: nowMs()
        });
      } catch {
        return;
      }
    });
    ws.on("close", () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    });
    ws.on("error", () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 2000);
    });
  };

  const start = () => {
    connect();
    refreshLadder();
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshLadder, refreshMs);
  };

  const getSnapshot = (): LadderSnapshot | null => {
    const now = nowMs();
    const values = ladderInstruments
      .map((instrument) => ivByInstrument.get(instrument))
      .filter((entry): entry is IvEntry => Boolean(entry))
      .filter((entry) => now - entry.ts <= maxAgeMs)
      .map((entry) => entry.markIv);
    if (values.length < 3) {
      if (lastSnapshot && now - lastSnapshot.ts <= maxSnapshotAgeMs) return lastSnapshot;
      return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const baseIv =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const hedgeIv = Math.max(...sorted);
      const legs = ladderLegs.map((leg) => {
      const entry = ivByInstrument.get(leg.instrument);
      if (!entry || now - entry.ts > maxAgeMs) {
        return { ...leg, markIv: null, markPrice: null };
      }
      const sourcePrice = entry.askPrice > 0 ? entry.askPrice : entry.markPrice;
      const bufferedPrice = sourcePrice * (1 + priceBufferPct);
        return {
          ...leg,
          markIv: entry.markIv,
        markPrice: bufferedPrice,
        markPriceUsd: bufferedPrice
        };
    });
    lastSnapshot = {
      baseIv,
      hedgeIv,
      ts: now,
      instruments: ladderInstruments
        .slice(),
      legs,
      spot: lastSpot
    };
    return lastSnapshot;
  };

  return { start, getSnapshot };
}
