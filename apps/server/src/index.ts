import { fileURLToPath } from "node:url";
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { buildApp } from "./app.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { createShutdown } from "./shutdown.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// esbuild defines __BUNDLED__ in build.mjs; it is undefined under tsx (pnpm dev).
declare const __BUNDLED__: boolean | undefined;
const bundled = typeof __BUNDLED__ !== "undefined" && __BUNDLED__;
// In the bundle, migrations and public/ sit next to index.js. From source, use the db package's folder.
const migrationsDir = bundled ? here("./migrations") : MIGRATIONS_DIR;
const webRoot = bundled ? here("./public") : undefined;

async function main() {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  await migrate(config.databaseUrl, migrationsDir);
  const { db, sql, close } = createDb(config.databaseUrl);
  const app = await buildApp(config, { db, sql, webRoot });
  const shutdown = createShutdown([() => app.close(), () => close()], {
    exit: (code) => process.exit(code),
    log: (message) => console.error(message),
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
