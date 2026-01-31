import Decimal from "decimal.js";

export interface EquityInputs {
  cashUsdc: Decimal;
  positionPnlUsdc: Decimal;
  hedgeMtmUsdc: Decimal;
  drawdownLimitUsdc: Decimal;
}

export interface RiskSummary {
  equityUsdc: Decimal;
  drawdownLimitUsdc: Decimal;
  drawdownBufferUsdc: Decimal;
  drawdownBufferPct: Decimal;
}

export function computeRiskSummary(
  inputs: EquityInputs,
  initialBalanceUsdc: Decimal
): RiskSummary {
  const equityUsdc = inputs.cashUsdc
    .plus(inputs.positionPnlUsdc)
    .plus(inputs.hedgeMtmUsdc);
  const drawdownBufferUsdc = equityUsdc.minus(inputs.drawdownLimitUsdc);
  const drawdownBufferPct = initialBalanceUsdc.equals(0)
    ? new Decimal(0)
    : drawdownBufferUsdc.div(initialBalanceUsdc);

  return {
    equityUsdc,
    drawdownLimitUsdc: inputs.drawdownLimitUsdc,
    drawdownBufferUsdc,
    drawdownBufferPct
  };
}
