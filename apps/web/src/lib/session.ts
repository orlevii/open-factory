import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { authClient, type Session } from "./auth-client";

export const sessionQueryOptions = queryOptions({
  queryKey: ["session"],
  queryFn: async (): Promise<Session | null> => (await authClient.getSession()).data ?? null,
  staleTime: 60_000,
});

/** Call after sign-in, sign-up and sign-out, before navigating, so the route guard never sees a stale session. */
export async function refreshSession(qc: QueryClient) {
  await qc.invalidateQueries({ queryKey: ["session"] });
  return qc.fetchQuery(sessionQueryOptions);
}
