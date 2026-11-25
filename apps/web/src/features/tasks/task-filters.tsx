import type { ReactNode } from "react";
import { AgentChip } from "@/components/agent-chip";
import type { ComboOption } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentCombobox } from "@/features/agents/agent-combobox";
import type { TaskFilters } from "./api";

const STATUS_OPTIONS = [
  ["open_in_progress", "Open and in progress"],
  ["open", "Open"],
  ["in_progress", "In progress"],
  ["done", "Done"],
  ["cancelled", "Cancelled"],
  ["all", "All"],
] as const;
const UNASSIGNED = "__unassigned";
// Stable, module-level: AgentCombobox memoizes its options on `fixed`.
const ASSIGNEE_FIXED: ComboOption[] = [
  { value: "", label: "Anyone", fixed: true },
  { value: UNASSIGNED, label: "Unassigned", fixed: true },
];
const CREATOR_FIXED: ComboOption[] = [
  { value: "", label: "Anyone", fixed: true },
  { value: "me", label: "Me", fixed: true },
];
/** A human `@handle` (or bare handle) from the URL is text; anything else is an agent slug. */
const creatorValue = (v: string): ReactNode =>
  v.startsWith("@") ? v : <AgentChip slug={v} badge showSlug />;

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
  const assignee = value.unassigned ? UNASSIGNED : (value.assignee ?? "");
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
        <AgentCombobox
          id="task-assignee"
          aria-label="Assignee"
          scope="live+ended"
          fixed={ASSIGNEE_FIXED}
          value={assignee}
          onValueChange={(v) =>
            onChange({
              ...value,
              assignee: v && v !== UNASSIGNED ? v : undefined,
              unassigned: v === UNASSIGNED ? true : undefined,
            })
          }
        />
      </Field>
      <Field id="task-creator" label="Created by">
        <AgentCombobox
          id="task-creator"
          aria-label="Created by"
          scope="live+ended"
          fixed={CREATOR_FIXED}
          value={value.creator ?? ""}
          renderValue={creatorValue}
          onValueChange={(v) => onChange({ ...value, creator: v || undefined })}
        />
      </Field>
    </div>
  );
}
