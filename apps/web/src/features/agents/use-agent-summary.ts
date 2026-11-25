import type { AgentSummary } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { agentDetailQueryOptions, summaryFromAgentsList } from "@/features/session/api";

/** The agent the page header and Agent details show: a narrow read of the detail cache (the one
 *  `enqueueStatusFrame` patches), so only a change to the agent itself renders the reader, never the
 *  events, the queue or a chat refetch. Until the detail is cached it is the list's summary (a plain
 *  read: the detail arrives within the same visit and takes over). */
export function useAgentSummary(
  slug: string,
  /** A view mounting beside the layout reads what the layout fetched; it never fetches it again. */
  o: { refetchOnMount?: false } = {},
): AgentSummary | undefined {
  const qc = useQueryClient();
  const { data } = useQuery({
    ...agentDetailQueryOptions(slug),
    ...o,
    // Frames keep it current; a focus or a reconnect refetching it would only be a second GET.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    select: selectAgent,
  });
  return data ?? summaryFromAgentsList(qc, slug);
}

const selectAgent = (d: { agent: AgentSummary }) => d.agent;
