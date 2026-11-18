import { readFileSync } from "node:fs";

declare const __FACTORY_VERSION__: string | undefined;

function readRootVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}

/** Injected by esbuild in the bundle; read from the root package.json when running from source. */
export const FACTORY_VERSION: string =
  typeof __FACTORY_VERSION__ === "string" ? __FACTORY_VERSION__ : readRootVersion();
