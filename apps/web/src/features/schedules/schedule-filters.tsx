import { useQuery } from "@tanstack/react-query";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  ALL,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentsQueryOptions } from "@/features/session/api";
import { AgentItem } from "@/features/tasks/agent-picker";
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
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
      <div className="grid gap-1 md:w-52">
        <label
          htmlFor="schedule-target"
          className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
        >
          Target
        </label>
        <Select
          value={value.target ?? ALL}
          onValueChange={(v) => onChange({ ...value, target: v === ALL ? undefined : v })}
        >
          <SelectTrigger id="schedule-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any agent</SelectItem>
            {/* An ended target is reachable through the URL only; it shows while selected. */}
            {value.target && !slugs.includes(value.target) && (
              <AgentItem agent={{ slug: value.target, displayName: "" }} />
            )}
            {agents.map((a) => (
              <AgentItem key={a.slug} agent={a} />
            ))}
          </SelectContent>
        </Select>
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
