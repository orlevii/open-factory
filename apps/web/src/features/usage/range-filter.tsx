import { USAGE_DAYS, type UsageDays } from "@open-factory/shared";

/** "7 days" / "30 days" / "90 days" as a native radio group (arrow keys move), like the Ended filter. */
export function RangeFilter({
  value,
  onChange,
  name = "usage-range",
}: {
  value: UsageDays;
  onChange(days: UsageDays): void;
  name?: string;
}) {
  return (
    <fieldset className="flex w-fit items-center gap-0.5 rounded-md border border-border p-0.5">
      <legend className="sr-only">Range</legend>
      {USAGE_DAYS.map((d) => (
        <label
          key={d}
          className="flex h-6 cursor-pointer items-center rounded-sm px-2 text-[0.8125rem] text-muted-foreground tabular-nums transition-[background-color,color] duration-150 hover:text-foreground has-checked:bg-sidebar-accent has-checked:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name={name}
            value={d}
            checked={value === d}
            onChange={() => onChange(d)}
            className="sr-only"
          />
          {d} days
        </label>
      ))}
    </fieldset>
  );
}
