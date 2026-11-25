import type { FastifyRequest } from "fastify";
import type { Config } from "../config.ts";

/**
 * Browser origins the server trusts (better-auth trustedOrigins and the WebSocket Origin check): every public origin,
 * plus DEV_WEB_ORIGIN (the Vite dev server) outside production.
 */
export function trustedOrigins(config: Config): string[] {
  return [...config.publicOrigins, ...(config.isProduction ? [] : [config.devWebOrigin])];
}

/**
 * The public origin a request came in on: its own scheme and host when that is one of the public origins, else
 * PUBLIC_URL's. Behind a proxy listed in TRUST_PROXY, the scheme and host are the proxy's `X-Forwarded-*` ones.
 */
export function publicOriginOf(request: FastifyRequest, config: Config): string {
  try {
    const origin = new URL(`${request.protocol}://${request.host}`).origin;
    if (config.publicOrigins.includes(origin)) return origin;
  } catch {
    // A Host header that isn't a host: the fallback.
  }
  return config.publicOrigin;
}
