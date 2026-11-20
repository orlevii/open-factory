import type { AgentDetail, AgentSummary } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useWs } from "@/lib/ws-context";

/** agent_status frames reach every socket; fold them into the cached list and detail. */
export function useAgentStatusFrames() {
  const ws = useWs();
  const qc = useQueryClient();
  useEffect(
    () =>
      ws.listen((m) => {
        if (m.type !== "agent_status") return;
        // A frame without lastError clears it: the server omits the field once the error is gone.
        const patch = {
          status: m.status,
          turnOpen: m.turnOpen,
          lastError: m.lastError,
          restartPending: m.restartPending,
          restartWaitingOn: m.restartWaitingOn,
        };
        // Lists are keyed by the archived filter (["agents", "exclude"] ...): patch every variant.
        const cached = qc.getQueriesData<AgentSummary[]>({ queryKey: ["agents"] });
        if (cached.some(([, l]) => l?.some((a) => a.slug === m.agent))) {
          qc.setQueriesData<AgentSummary[]>({ queryKey: ["agents"] }, (l) =>
            l?.map((a) => (a.slug === m.agent ? { ...a, ...patch } : a)),
          );
        } else {
          // Not cached yet (frame beat the fetch, or a new agent): refetch rather than lose it.
          void qc.invalidateQueries({ queryKey: ["agents"] });
        }
        if (qc.getQueryData<AgentDetail>(["agent", m.agent])) {
          qc.setQueryData<AgentDetail>(["agent", m.agent], (d) =>
            d ? { ...d, agent: { ...d.agent, ...patch } } : d,
          );
        } else {
          void qc.invalidateQueries({ queryKey: ["agent", m.agent] });
        }
      }),
    [ws, qc],
  );
}
