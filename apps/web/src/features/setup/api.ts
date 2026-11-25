import { apiFetch, setupStatusSchema } from "@open-factory/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";

/** The first-run state. Once an agent exists the answer never changes back (I8 Q11), so it stays fresh. */
export const setupQueryOptions = queryOptions({
  queryKey: ["setup"],
  queryFn: () => apiFetch("/api/setup", { schema: setupStatusSchema }),
  staleTime: (q) => (q.state.data?.hasAgent ? Number.POSITIVE_INFINITY : 30_000),
  refetchOnWindowFocus: true,
});

export const useSetup = () => useQuery(setupQueryOptions);
