import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ALL,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

/** "@slug · Display name" (UI design §8.1). */
export const agentOptionLabel = (a: { slug: string; displayName: string }) =>
  `@${a.slug} · ${a.displayName}`;

/** An agent as a select option: the name, then a muted mono `@slug`. Shown in the closed trigger too. */
export function AgentItem({ agent }: { agent: { slug: string; displayName: string } }) {
  return (
    <SelectItem value={agent.slug} textValue={agent.slug}>
      {agent.displayName && (
        <>
          <span>{agent.displayName}</span>{" "}
        </>
      )}
      <span className="text-muted-foreground font-mono">@{agent.slug}</span>
    </SelectItem>
  );
}

/** The create form's picker: nothing is sent until "Create task". "" is Unassigned (the ALL sentinel inside). */
export function AgentPicker({
  id,
  value,
  onChange,
  describedBy,
  placeholder = "Unassigned",
  extraOption,
}: {
  id: string;
  value: string;
  onChange(slug: string): void;
  describedBy?: string | undefined;
  /** The empty option's text: "Unassigned" for tasks, "Choose an agent…" for schedules. */
  placeholder?: string;
  /** An agent that isn't assignable (archived) but is the current value: kept as an option while selected. */
  extraOption?: { value: string; label: string } | undefined;
}) {
  const { agents } = useAssignableAgents();
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger id={id} aria-describedby={describedBy}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}</SelectItem>
        {extraOption && !agents.some((a) => a.slug === extraOption.value) && (
          <SelectItem value={extraOption.value}>{extraOption.label}</SelectItem>
        )}
        {agents.map((a) => (
          <AgentItem key={a.slug} agent={a} />
        ))}
      </SelectContent>
    </Select>
  );
}
