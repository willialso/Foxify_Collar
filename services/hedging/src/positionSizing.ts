import Decimal from "decimal.js";

export function hedgeSizeFromNotional(positionSize: Decimal, contractSize: Decimal): Decimal {
  if (contractSize.equals(0)) return new Decimal(0);
  return positionSize.mul(new Decimal(1)).div(contractSize);
}

export function hedgeSizeFromDelta(positionDelta: Decimal, optionDelta: Decimal): Decimal {
  if (optionDelta.equals(0)) return new Decimal(0);
  return positionDelta.div(optionDelta).abs();
}

export function capHedgeSize(desiredSize: Decimal, availableSize?: Decimal): Decimal {
  if (!availableSize || availableSize.lte(0)) return desiredSize;
  return Decimal.min(desiredSize, availableSize);
}
