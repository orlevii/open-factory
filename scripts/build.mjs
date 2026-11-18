import { execSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
rmSync("apps/server/dist", { recursive: true, force: true });
run("pnpm --filter @open-factory/server build");
// The CLI and web packages arrive in later tasks; build them only once they exist.
if (existsSync("apps/cli/build.mjs")) run("pnpm --filter @open-factory/cli build");
if (existsSync("apps/web/package.json")) run("pnpm --filter @open-factory/web build");
cpSync("packages/db/migrations", "apps/server/dist/migrations", { recursive: true });
if (existsSync("apps/web/dist"))
  cpSync("apps/web/dist", "apps/server/dist/public", { recursive: true });
