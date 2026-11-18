import type { Config } from "../config.ts";

/**
 * Browser origins the server trusts (better-auth trustedOrigins and the WebSocket Origin check).
 * DEV_WEB_ORIGIN (the Vite dev server) is trusted only outside production.
 */
export function trustedOrigins(config: Config): string[] {
  return [config.publicOrigin, ...(config.isProduction ? [] : [config.devWebOrigin])];
}
