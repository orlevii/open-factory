import { USAGE_DAYS, type UsageDays } from "@open-factory/shared";
import { SegmentedControl } from "@/components/ui/segmented-control";

const OPTIONS = USAGE_DAYS.map((d) => ({ value: d, label: `${d} days` }));

/** "7 days" / "30 days" / "90 days" as a segmented control (arrow keys move), like the Ended filter. */
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
    <SegmentedControl
      legend="Range"
      name={name}
      size="sm"
      className="w-fit"
      value={value}
      options={OPTIONS}
      onChange={onChange}
    />
  );
}
