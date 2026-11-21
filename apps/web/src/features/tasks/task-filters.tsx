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
import { AgentItem } from "./agent-picker";
import type { TaskFilters } from "./api";

export const DEFAULT_FILTERS: TaskFilters = { status: "open_in_progress" };

const STATUS_OPTIONS = [
  ["open_in_progress", "Open and in progress"],
  ["open", "Open"],
  ["in_progress", "In progress"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
  ["all", "All"],
] as const;
const UNASSIGNED = "__unassigned";

export const isDefault = (f: TaskFilters) =>
  f.status === "open_in_progress" && !f.assignee && !f.unassigned && !f.creator;

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 md:w-52">
      <label htmlFor={id} className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * Three selects (UI design §5). They only filter (no side effects), so changing on each arrow key is harmless.
 * Values live in the URL; `onChange` receives the whole new filter set.
 */
export function TaskFiltersBar({
  value,
  onChange,
}: {
  value: TaskFilters;
  onChange(next: TaskFilters): void;
}) {
  const { data: agents = [] } = useQuery(agentsQueryOptions);
  const slugs = agents.map((a) => a.slug);
  const assignee = value.unassigned ? UNASSIGNED : (value.assignee ?? ALL);
  const creator = value.creator ?? ALL;
  return (
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
      <Field id="task-status" label="Status">
        <Select
          value={value.status}
          onValueChange={(v) => onChange({ ...value, status: v as TaskFilters["status"] })}
        >
          <SelectTrigger id="task-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id="task-assignee" label="Assignee">
        <Select
          value={assignee}
          onValueChange={(v) =>
            onChange({
              ...value,
              assignee: v !== ALL && v !== UNASSIGNED ? v : undefined,
              unassigned: v === UNASSIGNED ? true : undefined,
            })
          }
        >
          <SelectTrigger id="task-assignee">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Anyone</SelectItem>
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
            {/* An ended assignee is reachable through the URL only; it shows while selected. */}
            {value.assignee && !slugs.includes(value.assignee) && (
              <AgentItem agent={{ slug: value.assignee, displayName: "" }} />
            )}
            {agents.map((a) => (
              <AgentItem key={a.slug} agent={a} />
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id="task-creator" label="Created by">
        <Select
          value={creator}
          onValueChange={(v) => onChange({ ...value, creator: v === ALL ? undefined : v })}
        >
          <SelectTrigger id="task-creator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Anyone</SelectItem>
            <SelectItem value="me">Me</SelectItem>
            {/* A human `@handle` works in the URL and shows while selected. */}
            {creator !== ALL && creator !== "me" && !slugs.includes(creator) && (
              <SelectItem value={creator}>
                {creator.startsWith("@") ? creator : `@${creator}`}
              </SelectItem>
            )}
            {agents.map((a) => (
              <AgentItem key={a.slug} agent={a} />
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
