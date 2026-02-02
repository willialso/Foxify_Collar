import { readFile, stat } from "node:fs/promises";
import { z } from "zod";

const accountConfigSchema = z.object({
  accountId: z.string(),
  tierName: z.enum(["Pro (Bronze)", "Pro (Silver)", "Pro (Gold)", "Pro (Platinum)"]),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  initialBalanceUsdc: z.string().optional(),
  drawdownLimitUsdc: z.string().optional(),
  bufferTargetPct: z.number().optional(),
  hedgeInstrument: z.string().optional(),
  hedgeSize: z.string().optional(),
  hysteresisPct: z.number().optional(),
  expiryIso: z.string().optional(),
  renewWindowMinutes: z.number().optional(),
  renewPayload: z.record(z.any()).optional(),
  alertWebhookUrl: z.string().optional(),
  maxLeverage: z.number().optional()
});

export type AccountConfig = z.infer<typeof accountConfigSchema>;

const configsSchema = z.object({
  accounts: z.array(accountConfigSchema)
});

type ConfigsData = z.infer<typeof configsSchema>;

let cachedConfig: ConfigsData | null = null;
let cachedMtime = 0;

export async function loadAccountConfig(
  configPath: string | URL
): Promise<ConfigsData> {
  const pathStr = configPath instanceof URL ? configPath.pathname : configPath;

  try {
    const stats = await stat(pathStr);
    const mtime = stats.mtimeMs;

    if (cachedConfig && mtime === cachedMtime) {
      return cachedConfig;
    }

    const raw = await readFile(pathStr, "utf-8");
    const parsed = JSON.parse(raw);
    const result = configsSchema.safeParse(parsed);

    if (!result.success) {
      console.error("Config validation failed:", result.error);
      if (cachedConfig) {
        console.warn("Using cached config due to validation error");
        return cachedConfig;
      }
      throw new Error(`Invalid config: ${result.error.message}`);
    }

    cachedConfig = result.data;
    cachedMtime = mtime;
    return result.data;
  } catch (error) {
    if (cachedConfig) {
      console.warn("Using cached config due to file read error:", error);
      return cachedConfig;
    }
    throw error;
  }
}
