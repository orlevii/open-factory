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
        const patch = { status: m.status, turnOpen: m.turnOpen, lastError: m.lastError };
        qc.setQueryData<AgentSummary[]>(["agents"], (list) =>
          list?.map((a) => (a.slug === m.agent ? { ...a, ...patch } : a)),
        );
        qc.setQueryData<AgentDetail>(["agent", m.agent], (d) =>
          d ? { ...d, agent: { ...d.agent, ...patch } } : d,
        );
      }),
    [ws, qc],
  );
}
