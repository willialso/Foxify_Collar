import Decimal from "decimal.js";
import { ExposurePosition, NetExposure } from "./types";

export function calculateNetExposure(positions: ExposurePosition[]): NetExposure[] {
  const byAsset: Record<string, Decimal> = {};
  for (const pos of positions) {
    const notional = pos.entryPrice.mul(pos.size).mul(pos.leverage);
    const signed = pos.side === "long" ? notional : notional.negated();
    byAsset[pos.asset] = (byAsset[pos.asset] || new Decimal(0)).add(signed);
  }

  return Object.entries(byAsset).map(([asset, netNotional]) => ({
    asset,
    netNotional,
    netDelta: netNotional.eq(0) ? new Decimal(0) : new Decimal(1).mul(netNotional.isNegative() ? -1 : 1)
  }));
}
