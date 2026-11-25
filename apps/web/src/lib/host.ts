import { apiFetch, hostInfoSchema } from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";

/** The factory machine's platform, hostname and home (path help). Constant while the server runs. */
export const hostQueryOptions = queryOptions({
  queryKey: ["host"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: () => apiFetch("/api/host", { schema: hostInfoSchema }),
});
