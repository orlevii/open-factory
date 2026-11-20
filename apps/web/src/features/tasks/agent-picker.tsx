import { useQuery } from "@tanstack/react-query";
import { NativeSelect } from "@/components/native-select";
import { agentsQueryOptions } from "@/features/session/api";

/** Live agents sorted by display name (S4's order), spawned agents included (their " · ab12" tells them apart). */
export function useAssignableAgents() {
  const { data, ...rest } = useQuery(agentsQueryOptions);
  const agents = [...(data ?? [])]
    .filter((a) => !a.archivedAt && !a.terminatedAt)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.slug.localeCompare(b.slug));
  return { agents, ...rest };
}

/** "@slug · Display name" (UI design §8.1). */
export const agentOptionLabel = (a: { slug: string; displayName: string }) =>
  `@${a.slug} · ${a.displayName}`;

/** The create form's picker: a native select, since nothing is sent until "Create task". "" is Unassigned. */
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
    <NativeSelect
      id={id}
      value={value}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {extraOption && !agents.some((a) => a.slug === extraOption.value) && (
        <option value={extraOption.value}>{extraOption.label}</option>
      )}
      {agents.map((a) => (
        <option key={a.slug} value={a.slug}>
          {agentOptionLabel(a)}
        </option>
      ))}
    </NativeSelect>
  );
}
