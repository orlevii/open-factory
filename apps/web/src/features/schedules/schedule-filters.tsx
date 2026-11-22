import { Checkbox } from "@/components/ui/checkbox";
import type { ComboOption } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { AgentCombobox } from "@/features/agents/agent-combobox";
import type { ScheduleFilters } from "./api";

const ANY_AGENT: ComboOption[] = [{ value: "", label: "Any agent", fixed: true }];

export const isDefault = (f: ScheduleFilters) => !f.target && !f.done;

/** Target (a visible label, "Any agent") and Show done; values live in the URL, no Apply button (UI design §2). */
export function ScheduleFiltersBar({
  value,
  onChange,
}: {
  value: ScheduleFilters;
  onChange(next: ScheduleFilters): void;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
      <div className="grid gap-1 md:w-52">
        <label
          htmlFor="schedule-target"
          className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
        >
          Target
        </label>
        <AgentCombobox
          id="schedule-target"
          aria-label="Target"
          scope="live+ended"
          fixed={ANY_AGENT}
          value={value.target ?? ""}
          onValueChange={(v) => onChange({ ...value, target: v || undefined })}
        />
      </div>
      <div className="flex items-center gap-2 md:pb-2">
        <Checkbox
          id="schedule-done"
          checked={Boolean(value.done)}
          onCheckedChange={(c) => onChange({ ...value, done: c === true ? true : undefined })}
        />
        <Label htmlFor="schedule-done">Show done</Label>
      </div>
    </div>
  );
}
