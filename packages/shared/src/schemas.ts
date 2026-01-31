import { z } from "zod";

export const positionSchema = z.object({
  symbol: z.string(),
  side: z.enum(["long", "short"]),
  size: z.string(),
  entryPrice: z.string(),
  markPrice: z.string(),
  leverage: z.string(),
  unrealizedPnlUsdc: z.string()
});

export const riskSummarySchema = z.object({
  equityUsdc: z.string(),
  drawdownLimitUsdc: z.string(),
  drawdownBufferUsdc: z.string(),
  drawdownBufferPct: z.string()
});
