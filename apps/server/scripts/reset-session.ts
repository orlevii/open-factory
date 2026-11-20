// Interim recovery (S4): `pnpm agent:reset-session <slug>`.
import { createDb } from "@open-factory/db";
import { resetSession } from "../src/agents/reset-session.ts";
import { loadConfig } from "../src/config.ts";

const slug = process.argv[2];
if (!slug) {
  console.error(
    "Usage: pnpm agent:reset-session <slug>\n\n" +
      'Interim recovery for an agent whose session can\'t be resumed ("No conversation found"). ' +
      "The server must be stopped. A later release replaces this with an automatic path.",
  );
  process.exit(1);
}
const config = loadConfig(process.env);
const running = await fetch(`${config.publicUrl}/api/status`, {
  signal: AbortSignal.timeout(1000),
}).then(
  (r) => r.ok,
  () => false,
);
if (running) {
  console.error(`Stop the server first (it answers on ${config.publicUrl}).`);
  process.exit(1);
}
const { db, close } = createDb(config.databaseUrl);
try {
  await resetSession(db, slug);
  console.log(`Session reset. @${slug} starts a new Claude session on its next message.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await close();
}
