import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { agentsQueryOptions } from "@/features/session/api";

type Agents = AgentSummary[];
const NONE: Agents = [];

/**
 * The query's `select`: a stable module function, so TanStack Query runs it once per fetched list
 * (not on every render of every picker) and keeps the result's identity between renders.
 */
const assignable = (data: Agents): Agents =>
  data
    .filter((a) => !a.archivedAt && !a.terminatedAt)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.slug.localeCompare(b.slug));

/** Live agents sorted by display name (S4's order), spawned agents included (their " · ab12" tells them apart). */
export function useAssignableAgents() {
  const { data, ...rest } = useQuery({ ...agentsQueryOptions, select: assignable });
  return { agents: data ?? NONE, ...rest };
}

/** The muted mono `@slug` that follows a name in agent options and triggers. */
export const Slug = ({ slug }: { slug: string }) => (
  <span className="text-muted-foreground font-mono">@{slug}</span>
);
