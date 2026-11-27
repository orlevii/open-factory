import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { principalsQueryOptions } from "./api";

/**
 * The blur-time taken check (§4.5): the message when any principal other than `ownRef` holds `handle` in the loaded
 * principals cache, else undefined. Until the cache loads nothing is judged; the server's 409 stays the backstop.
 */
export function useHandleTaken(ownRef: string | undefined): (handle: string) => string | undefined {
  const cache = useQuery(principalsQueryOptions).data;
  return useCallback(
    (handle) => {
      if (!cache) return undefined;
      for (const p of cache.byRef.values())
        if (p.handle === handle && p.ref !== ownRef) return FORM_MSG.handleTaken;
      return undefined;
    },
    [cache, ownRef],
  );
}
