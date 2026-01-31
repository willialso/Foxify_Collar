import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const accountSchema = z.object({
  accountId: z.string(),
  drawdownLimitUsdc: z.string(),
  initialBalanceUsdc: z.string(),
  hedgeInstrument: z.string(),
  hedgeSize: z.number(),
  bufferTargetPct: z.number(),
  hysteresisPct: z.number(),
  expiryIso: z.string(),
  renewWindowMinutes: z.number(),
  renewPayload: z.record(z.unknown()),
  alertWebhookUrl: z.string().optional()
});

const configSchema = z.object({
  accounts: z.array(accountSchema)
});

let cachedConfig: z.infer<typeof configSchema> | null = null;
let cachedMtimeMs = 0;

export async function loadAccountConfig(path: string): Promise<z.infer<typeof configSchema>> {
  const fileStat = await stat(path);
  if (cachedConfig && fileStat.mtimeMs === cachedMtimeMs) {
    return cachedConfig;
  }

  const raw = await readFile(path, "utf-8");
  const parsed = configSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    if (cachedConfig) {
      return cachedConfig;
    }
    throw new Error("Invalid account config");
  }

  cachedConfig = parsed.data;
  cachedMtimeMs = fileStat.mtimeMs;
  return parsed.data;
}
