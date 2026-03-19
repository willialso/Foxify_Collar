import { pilotConfig } from "./config";
import { ensurePilotSchema, getPilotPool } from "./db";

async function main() {
  if (!pilotConfig.postgresUrl) {
    throw new Error("POSTGRES_URL or DATABASE_URL is required");
  }
  const pool = getPilotPool(pilotConfig.postgresUrl);
  await ensurePilotSchema(pool);
  await pool.end();
  // eslint-disable-next-line no-console
  console.log("Pilot schema migration complete.");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Pilot schema migration failed:", error);
  process.exit(1);
});

