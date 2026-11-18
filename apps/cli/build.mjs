import { chmodSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const rootPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
// One self-contained file: every dependency (workspace and third-party) is bundled.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/open-factory.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  define: { __FACTORY_VERSION__: JSON.stringify(rootPkg.version) },
  logLevel: "info",
});
chmodSync("dist/open-factory.js", 0o755); // runnable directly via its shebang
