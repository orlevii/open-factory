import { useQuery } from "@tanstack/react-query";
import { NativeSelect } from "@/components/native-select";
import { agentsQueryOptions } from "@/features/session/api";
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
 * Three native selects (UI design §5). They only filter (no side effects), so changing on each arrow key is harmless.
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
  const assignee = value.unassigned ? UNASSIGNED : (value.assignee ?? "");
  const creator = value.creator ?? "";
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end">
      <Field id="task-status" label="Status">
        <NativeSelect
          id="task-status"
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value as TaskFilters["status"] })}
        >
          {STATUS_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="task-assignee" label="Assignee">
        <NativeSelect
          id="task-assignee"
          value={assignee}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              ...value,
              assignee: v && v !== UNASSIGNED ? v : undefined,
              unassigned: v === UNASSIGNED ? true : undefined,
            });
          }}
        >
          <option value="">Anyone</option>
          <option value={UNASSIGNED}>Unassigned</option>
          {/* An ended assignee is reachable through the URL only; it shows while selected. */}
          {value.assignee && !slugs.includes(value.assignee) && (
            <option value={value.assignee}>@{value.assignee}</option>
          )}
          {slugs.map((s) => (
            <option key={s} value={s}>
              @{s}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="task-creator" label="Created by">
        <NativeSelect
          id="task-creator"
          value={creator}
          onChange={(e) => onChange({ ...value, creator: e.target.value || undefined })}
        >
          <option value="">Anyone</option>
          <option value="me">Me</option>
          {/* A human `@handle` works in the URL and shows while selected. */}
          {creator && creator !== "me" && !slugs.includes(creator) && (
            <option value={creator}>{creator.startsWith("@") ? creator : `@${creator}`}</option>
          )}
          {slugs.map((s) => (
            <option key={s} value={s}>
              @{s}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </div>
  );
}
