import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { usePrincipal } from "@/features/principals/use-principal";
import { agentsListQueryOptions } from "@/features/session/api";

/** A ref index per list-data identity: a status frame costs one O(n) build, however many chips
 *  select from it. Read it inside a `select`, never return it from one: a `Map` returned from a
 *  `select` would lose structural sharing. */
const INDEXES = new WeakMap<AgentSummary[], Map<string, AgentSummary>>();
export function agentIndex(list: AgentSummary[]): Map<string, AgentSummary> {
  let m = INDEXES.get(list);
  if (!m) {
    m = new Map(list.map((a) => [a.ref, a]));
    INDEXES.set(list, m);
  }
  return m;
}

/** The live agent with this ref. Identity-stable across frames that don't change that agent. */
export function useAgent(ref: string): AgentSummary | undefined {
  const select = useCallback((l: AgentSummary[]) => agentIndex(l).get(ref), [ref]);
  return useQuery({ ...agentsListQueryOptions("exclude"), refetchOnMount: false, select }).data;
}

/** Whether the ref is a live agent; undefined until the list has loaded. Unlike the chips' reads
 *  it may fetch the list itself: the sidebar asks even while its tree is not mounted. */
export function useIsLiveAgent(ref: string): boolean | undefined {
  const select = useCallback((l: AgentSummary[]) => agentIndex(l).has(ref), [ref]);
  return useQuery({ ...agentsListQueryOptions("exclude"), select }).data;
}

/** An ended agent from the cached ended list. A cache read only: a chip never fetches that list. */
export function useEndedAgent(ref: string): AgentSummary | undefined {
  const select = useCallback((l: AgentSummary[]) => agentIndex(l).get(ref), [ref]);
  return useQuery({ ...agentsListQueryOptions("only"), enabled: false, select }).data;
}

/** The agent's current handle for text: the principals cache (a rename patches it at once), else the lists; "…" while neither knows it. */
export function useHandle(ref: string): string {
  const p = usePrincipal(ref).principal;
  const live = useAgent(ref);
  const ended = useEndedAgent(ref);
  return p?.handle ?? (live ?? ended)?.handle ?? "…";
}
