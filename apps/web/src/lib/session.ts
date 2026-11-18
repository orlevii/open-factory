import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { authClient, type Session } from "./auth-client";

export const sessionQueryOptions = queryOptions({
  queryKey: ["session"],
  queryFn: async (): Promise<Session | null> => {
    const { data, error } = await authClient.getSession();
    // Only a definite absence (null body or 401) means "signed out". A 5xx or network error must not
    // sign the user out of the UI; throwing keeps the cached session and lets callers retry.
    if (error && error.status !== 401) {
      throw new Error(`Session check failed: ${error.status} ${error.message ?? error.statusText}`);
    }
    return data ?? null;
  },
  staleTime: 60_000,
});

/** Call after sign-in, sign-up and sign-out, before navigating, so the route guard never sees a stale session. */
export async function refreshSession(qc: QueryClient) {
  await qc.invalidateQueries({ queryKey: ["session"] });
  return qc.fetchQuery(sessionQueryOptions);
}
