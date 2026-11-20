// Dev tooling (S3): `pnpm seed:dev-agent [--reset-session]`. Removed in S4.
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { resetDevSession, seedDevAgent } from "../src/agents/seed-dev.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig(process.env);
await migrate(config.databaseUrl, MIGRATIONS_DIR);
const { db, close } = createDb(config.databaseUrl);
try {
  if (process.argv.includes("--reset-session")) {
    const running = await fetch(`${config.publicUrl}/api/status`, {
      signal: AbortSignal.timeout(1000),
    }).then(
      (r) => r.ok,
      () => false,
    );
    if (running) {
      console.error(`Stop the server first (it answers on ${config.publicUrl}).`);
      process.exitCode = 1;
    } else {
      await resetDevSession(db, config);
      console.log("Session reset. The dev agent starts a new Claude session on its next message.");
    }
  } else {
    const a = await seedDevAgent(db, config);
    console.log(`Agent "${a.slug}" is ready (working dir ${config.factoryHome}/agents/${a.slug}).`);
  }
} finally {
  await close();
}
