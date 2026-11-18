import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const rootPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
// Third-party deps stay external (resolved from apps/server/node_modules); workspace packages are bundled.
const external = Object.entries(pkg.dependencies ?? {})
  .filter(([, v]) => !String(v).startsWith("workspace:"))
  .flatMap(([name]) => [name, `${name}/*`]);

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external,
  define: { __FACTORY_VERSION__: JSON.stringify(rootPkg.version), __BUNDLED__: "true" },
  sourcemap: true,
  logLevel: "info",
});
