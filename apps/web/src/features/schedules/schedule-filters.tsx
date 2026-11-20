import { useQuery } from "@tanstack/react-query";
import { NativeSelect } from "@/components/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { agentsQueryOptions } from "@/features/session/api";
import type { ScheduleFilters } from "./api";

export const isDefault = (f: ScheduleFilters) => !f.target && !f.done;

/** Target (a visible label, "Any agent") and Show done; values live in the URL, no Apply button (UI design §2). */
export function ScheduleFiltersBar({
  value,
  onChange,
}: {
  value: ScheduleFilters;
  onChange(next: ScheduleFilters): void;
}) {
  const { data: agents = [] } = useQuery(agentsQueryOptions);
  const slugs = agents.map((a) => a.slug);
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end">
      <div className="grid gap-1 md:w-52">
        <label
          htmlFor="schedule-target"
          className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
        >
          Target
        </label>
        <NativeSelect
          id="schedule-target"
          value={value.target ?? ""}
          onChange={(e) => onChange({ ...value, target: e.target.value || undefined })}
        >
          <option value="">Any agent</option>
          {/* An ended target is reachable through the URL only; it shows while selected. */}
          {value.target && !slugs.includes(value.target) && (
            <option value={value.target}>@{value.target}</option>
          )}
          {slugs.map((s) => (
            <option key={s} value={s}>
              @{s}
            </option>
          ))}
        </NativeSelect>
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
