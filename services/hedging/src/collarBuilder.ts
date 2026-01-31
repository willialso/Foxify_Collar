import Decimal from "decimal.js";

export interface ProtectiveOptionInputs {
  spotPrice: Decimal;
  drawdownFloorPct: Decimal;
  fixedPriceUsdc: Decimal;
  side: "put" | "call";
  requiredSize?: Decimal;
  maxSpreadPct?: Decimal;
  scoring?: Partial<OptionScoreWeights>;
  ivPenaltyThreshold?: Decimal;
  maxDistancePct?: Decimal;
  options: Array<{
    strike: Decimal;
    mid: Decimal;
    bid?: Decimal | null;
    ask?: Decimal | null;
    bidSize?: Decimal;
    askSize?: Decimal;
    spreadPct?: Decimal;
    iv?: number;
  }>;
}

export interface ProtectiveOptionQuote {
  strike: Decimal;
  premiumUsdc: Decimal;
  premiumPerUnitUsdc?: Decimal;
  iv?: number;
  score?: Decimal;
  scoreDetails?: OptionScoreDetails;
}

export interface OptionScoreWeights {
  protection: Decimal;
  premium: Decimal;
  liquidity: Decimal;
  volatility: Decimal;
}

export interface OptionScoreDetails {
  protectionScore: Decimal;
  premiumScore: Decimal;
  liquidityScore: Decimal;
  volatilityPenalty: Decimal;
  distancePct: Decimal;
  spreadPct: Decimal;
  availableSize: Decimal;
}

const DEFAULT_WEIGHTS: OptionScoreWeights = {
  protection: new Decimal(0.4),
  premium: new Decimal(0.25),
  liquidity: new Decimal(0.25),
  volatility: new Decimal(0.1)
};

export function buildFixedPriceOption(
  inputs: ProtectiveOptionInputs
): ProtectiveOptionQuote | null {
  const floorStrike =
    inputs.side === "put"
      ? inputs.spotPrice.mul(new Decimal(1).minus(inputs.drawdownFloorPct))
      : inputs.spotPrice.mul(new Decimal(1).plus(inputs.drawdownFloorPct));
  const requiredSize = inputs.requiredSize ?? new Decimal(0);
  const maxSpreadPct = inputs.maxSpreadPct ?? new Decimal(0.05);
  const ivPenaltyThreshold = inputs.ivPenaltyThreshold ?? new Decimal(0.8);
  const maxDistancePct = inputs.maxDistancePct ?? new Decimal(0.25);
  const weights = {
    protection: inputs.scoring?.protection ?? DEFAULT_WEIGHTS.protection,
    premium: inputs.scoring?.premium ?? DEFAULT_WEIGHTS.premium,
    liquidity: inputs.scoring?.liquidity ?? DEFAULT_WEIGHTS.liquidity,
    volatility: inputs.scoring?.volatility ?? DEFAULT_WEIGHTS.volatility
  };

  const eligible = inputs.options
    .filter((opt) => opt.strike.greaterThanOrEqualTo(floorStrike))
    .sort((a, b) => a.strike.sub(b.strike).toNumber());

  const candidates: Array<ProtectiveOptionQuote> = [];
  for (const opt of eligible) {
    const premiumPerUnit = opt.mid;
    const sizeForPricing = requiredSize.gt(0) ? requiredSize : new Decimal(1);
    const premiumTotal = premiumPerUnit.mul(sizeForPricing);
    if (premiumTotal.gt(inputs.fixedPriceUsdc)) continue;
    const spreadPct = opt.spreadPct ?? new Decimal(0);
    if (spreadPct.gt(maxSpreadPct)) continue;
    const availableSize = opt.askSize ?? opt.bidSize ?? new Decimal(0);
    if (requiredSize.gt(0) && availableSize.lt(requiredSize)) continue;

    const distance = opt.strike.minus(floorStrike);
    const distancePct = inputs.spotPrice.equals(0)
      ? new Decimal(0)
      : distance.div(inputs.spotPrice);
    const protectionScore = new Decimal(1).minus(
      Decimal.min(distancePct.div(maxDistancePct), new Decimal(1))
    );
    const premiumScore = inputs.fixedPriceUsdc.equals(0)
      ? new Decimal(0)
      : Decimal.max(
          new Decimal(0),
          inputs.fixedPriceUsdc.minus(premiumTotal).div(inputs.fixedPriceUsdc)
        );
    const spreadScore = new Decimal(1).minus(
      Decimal.min(spreadPct.div(maxSpreadPct), new Decimal(1))
    );
    const sizeScore = requiredSize.equals(0)
      ? new Decimal(1)
      : Decimal.min(availableSize.div(requiredSize), new Decimal(1));
    const liquidityScore = spreadScore.mul(new Decimal(0.6)).add(sizeScore.mul(new Decimal(0.4)));

    const iv = opt.iv ?? 0;
    const ivDecimal = new Decimal(iv);
    const volatilityPenalty = ivPenaltyThreshold.equals(0)
      ? new Decimal(0)
      : Decimal.max(new Decimal(0), ivDecimal.minus(ivPenaltyThreshold).div(ivPenaltyThreshold));

    const score = protectionScore
      .mul(weights.protection)
      .add(premiumScore.mul(weights.premium))
      .add(liquidityScore.mul(weights.liquidity))
      .minus(volatilityPenalty.mul(weights.volatility));

    const scoreDetails: OptionScoreDetails = {
      protectionScore,
      premiumScore,
      liquidityScore,
      volatilityPenalty,
      distancePct,
      spreadPct,
      availableSize
    };

    candidates.push({
      strike: opt.strike,
      premiumUsdc: premiumTotal,
      premiumPerUnitUsdc: premiumPerUnit,
      iv: opt.iv,
      score,
      scoreDetails
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const premiumDiff = a.premiumUsdc.sub(b.premiumUsdc).toNumber();
    if (premiumDiff !== 0) return premiumDiff;
    const distanceDiff = a.scoreDetails?.distancePct
      ?.sub(b.scoreDetails?.distancePct ?? new Decimal(0))
      .toNumber();
    if (distanceDiff !== 0) return distanceDiff;
    return (a.scoreDetails?.spreadPct ?? new Decimal(0))
      .sub(b.scoreDetails?.spreadPct ?? new Decimal(0))
      .toNumber();
  });

  return candidates[0];
}
