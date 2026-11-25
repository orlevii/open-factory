import { execSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
rmSync("apps/server/dist", { recursive: true, force: true });
run("pnpm --filter @open-factory/server build");
run("pnpm --filter @open-factory/cli build");
run("pnpm --filter @open-factory/web build");
cpSync("packages/db/migrations", "apps/server/dist/migrations", { recursive: true });
cpSync("apps/web/dist", "apps/server/dist/public", { recursive: true });
