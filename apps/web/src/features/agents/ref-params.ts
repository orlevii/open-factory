import { normaliseRef } from "@open-factory/shared";

/**
 * The `$ref` path param of an agent route: a ref typed or copied with a different case (or an i, l or o for a 1 or 0)
 * is the same agent, so every reader below the route sees the canonical ref the caches and frames are keyed by.
 */
export const agentRefParams = {
  parse: ({ ref }: { ref: string }) => ({ ref: normaliseRef(ref) ?? ref }),
  stringify: ({ ref }: { ref: string }) => ({ ref }),
};
