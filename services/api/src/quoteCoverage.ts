import Decimal from "decimal.js";

type OptionType = "put" | "call";

function computeFloorPrice(
  spotPrice: Decimal,
  drawdownFloorPct: Decimal,
  optionType: OptionType
): Decimal {
  return optionType === "put"
    ? spotPrice.mul(new Decimal(1).minus(drawdownFloorPct))
    : spotPrice.mul(new Decimal(1).plus(drawdownFloorPct));
}

function computeIntrinsicAtFloor(params: {
  spotPrice: Decimal;
  drawdownFloorPct: Decimal;
  optionType: OptionType;
  strike: Decimal;
}): Decimal {
  const floorPrice = computeFloorPrice(
    params.spotPrice,
    params.drawdownFloorPct,
    params.optionType
  );
  return params.optionType === "put"
    ? Decimal.max(new Decimal(0), params.strike.sub(floorPrice))
    : Decimal.max(new Decimal(0), floorPrice.sub(params.strike));
}

function requiredHedgeSizeForFullCoverage(params: {
  spotPrice: Decimal;
  drawdownFloorPct: Decimal;
  optionType: OptionType;
  strike: Decimal;
  requiredSize: Decimal;
}): Decimal | null {
  const floorPrice = computeFloorPrice(
    params.spotPrice,
    params.drawdownFloorPct,
    params.optionType
  );
  const requiredCredit = params.spotPrice.sub(floorPrice).abs().mul(params.requiredSize);
  const intrinsic = computeIntrinsicAtFloor({
    spotPrice: params.spotPrice,
    drawdownFloorPct: params.drawdownFloorPct,
    optionType: params.optionType,
    strike: params.strike
  });
  if (intrinsic.lte(0)) return null;
  return requiredCredit.div(intrinsic);
}

export function resolveCoverageTargetSize(params: {
  spotPrice: Decimal;
  drawdownFloorPct: Decimal;
  optionType: OptionType;
  strike: Decimal;
  requiredSize: Decimal;
  minSize: Decimal;
}): Decimal | null {
  const coverageSize = requiredHedgeSizeForFullCoverage({
    spotPrice: params.spotPrice,
    drawdownFloorPct: params.drawdownFloorPct,
    optionType: params.optionType,
    strike: params.strike,
    requiredSize: params.requiredSize
  });
  if (!coverageSize || coverageSize.lte(0)) return null;
  return Decimal.max(params.minSize, coverageSize);
}
