import {
  agentsUsageSchema,
  agentUsageSchema,
  apiFetch,
  credentialsUsageSchema,
  dailyUsageSchema,
  type UsageDays,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";

/** Every key starts with "usage": one invalidation refreshes all views. */
export const dailyUsageQuery = (days: UsageDays) =>
  queryOptions({
    queryKey: ["usage", "daily", days],
    queryFn: () => apiFetch(`/api/usage/daily?days=${days}`, { schema: dailyUsageSchema }),
  });

/** `"rolling7"` is the tree's rolling 7 days (`window=rolling`); a number is the calendar window. */
export const agentsUsageQuery = (days: UsageDays | "rolling7") =>
  queryOptions({
    queryKey: ["usage", "agents", days],
    queryFn: () =>
      apiFetch(
        days === "rolling7" ? "/api/usage/agents?window=rolling" : `/api/usage/agents?days=${days}`,
        { schema: agentsUsageSchema },
      ),
  });

export const credentialsUsageQuery = (days: UsageDays) =>
  queryOptions({
    queryKey: ["usage", "credentials", days],
    queryFn: () =>
      apiFetch(`/api/usage/credentials?days=${days}`, { schema: credentialsUsageSchema }),
  });

export const agentUsageQuery = (slug: string, days: UsageDays) =>
  queryOptions({
    queryKey: ["usage", "agent", slug, days],
    queryFn: () =>
      apiFetch(`/api/agents/${encodeURIComponent(slug)}/usage?days=${days}`, {
        schema: agentUsageSchema,
      }),
  });
