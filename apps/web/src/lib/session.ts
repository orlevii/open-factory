import { ApiError, apiFetch, type Me, meSchema } from "@open-factory/shared";
import { type QueryClient, queryOptions } from "@tanstack/react-query";

/** The signed-in user, as `GET /api/me` answers (handle and ref come from the user's principal). */
export type Session = { user: Me };

export const sessionQueryOptions = queryOptions({
  queryKey: ["session"],
  queryFn: async (): Promise<Session | null> => {
    // Only a 401 means "signed out". A 5xx or network error must not sign the user out of the UI;
    // throwing keeps the cached session and lets callers retry.
    try {
      return { user: await apiFetch("/api/me", { schema: meSchema }) };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) return null;
        throw new Error(`Session check failed: ${e.status} ${e.message}`);
      }
      throw e;
    }
  },
  staleTime: 60_000,
});

/**
 * The signed-in guard's first check retries a failed one (5xx, network) with the query's own backoff
 * (1s, 2s, 4s, 8s) under the pending mark, so a page loaded while the server restarts waits for it
 * instead of landing on the error state. Only when it is still down after that does the error show.
 */
export const SESSION_GUARD_RETRIES = 4;

/** Call after sign-in, sign-up and sign-out, before navigating, so the route guard never sees a stale session. */
export async function refreshSession(qc: QueryClient) {
  await qc.invalidateQueries({ queryKey: ["session"] });
  return qc.fetchQuery(sessionQueryOptions);
}
