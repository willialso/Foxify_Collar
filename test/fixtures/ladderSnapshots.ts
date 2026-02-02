import type { LadderSnapshot } from "../../src/deribitIvLadder";

export const LADDER_SNAPSHOT_NORMAL: LadderSnapshot = {
  baseIv: 0.6,
  hedgeIv: 0.75,
  ts: Date.now(),
  instruments: [
    "BTC-1FEB25-88000-P",
    "BTC-1FEB25-84000-P",
    "BTC-1FEB25-80000-P",
    "BTC-4FEB25-88000-P",
    "BTC-4FEB25-84000-P",
    "BTC-4FEB25-80000-P",
    "BTC-8FEB25-88000-P",
    "BTC-8FEB25-84000-P",
    "BTC-8FEB25-80000-P"
  ],
  legs: [
    {
      tenorDays: 1,
      floorPct: 0.12,
      instrument: "BTC-1FEB25-88000-P",
      strike: 88000,
      markIv: 0.6,
      markPrice: 0.015
    },
    {
      tenorDays: 1,
      floorPct: 0.16,
      instrument: "BTC-1FEB25-84000-P",
      strike: 84000,
      markIv: 0.62,
      markPrice: 0.012
    },
    {
      tenorDays: 1,
      floorPct: 0.2,
      instrument: "BTC-1FEB25-80000-P",
      strike: 80000,
      markIv: 0.65,
      markPrice: 0.01
    },
    {
      tenorDays: 3,
      floorPct: 0.12,
      instrument: "BTC-4FEB25-88000-P",
      strike: 88000,
      markIv: 0.65,
      markPrice: 0.022
    },
    {
      tenorDays: 3,
      floorPct: 0.16,
      instrument: "BTC-4FEB25-84000-P",
      strike: 84000,
      markIv: 0.67,
      markPrice: 0.018
    },
    {
      tenorDays: 3,
      floorPct: 0.2,
      instrument: "BTC-4FEB25-80000-P",
      strike: 80000,
      markIv: 0.7,
      markPrice: 0.015
    },
    {
      tenorDays: 7,
      floorPct: 0.12,
      instrument: "BTC-8FEB25-88000-P",
      strike: 88000,
      markIv: 0.7,
      markPrice: 0.032
    },
    {
      tenorDays: 7,
      floorPct: 0.16,
      instrument: "BTC-8FEB25-84000-P",
      strike: 84000,
      markIv: 0.72,
      markPrice: 0.027
    },
    {
      tenorDays: 7,
      floorPct: 0.2,
      instrument: "BTC-8FEB25-80000-P",
      strike: 80000,
      markIv: 0.75,
      markPrice: 0.023
    }
  ],
  spot: 100000
};

export const LADDER_SNAPSHOT_HIGH_VOL: LadderSnapshot = {
  baseIv: 0.85,
  hedgeIv: 1.1,
  ts: Date.now(),
  instruments: LADDER_SNAPSHOT_NORMAL.instruments,
  legs: LADDER_SNAPSHOT_NORMAL.legs.map((leg) => ({
    ...leg,
    markIv: leg.markIv ? leg.markIv * 1.5 : null,
    markPrice: leg.markPrice ? leg.markPrice * 1.8 : null
  })),
  spot: 100000
};

export const LADDER_SNAPSHOT_STALE: LadderSnapshot = {
  ...LADDER_SNAPSHOT_NORMAL,
  legs: LADDER_SNAPSHOT_NORMAL.legs.map((leg) => ({
    ...leg,
    markIv: null,
    markPrice: null
  }))
};
