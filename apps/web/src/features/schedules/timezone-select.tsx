import { NativeSelect } from "@/components/native-select";

const REGIONS = [
  "Africa",
  "America",
  "Antarctica",
  "Asia",
  "Atlantic",
  "Australia",
  "Europe",
  "Indian",
  "Pacific",
];

/** Region groups from the browser's list plus UTC and the current value (the list omits UTC and some aliases). */
export function zoneGroups(
  current: string,
  supported?: string[],
): { region: string; zones: string[] }[] {
  const all = new Set(supported ?? supportedZones());
  all.add("UTC");
  if (current) all.add(current);
  const by = new Map<string, string[]>();
  for (const z of [...all].sort()) {
    const head = z.split("/")[0] ?? z;
    const region = REGIONS.includes(head) ? head : "Other";
    by.set(region, [...(by.get(region) ?? []), z]);
  }
  return [...REGIONS, "Other"].flatMap((r) =>
    by.has(r) ? [{ region: r, zones: by.get(r) as string[] }] : [],
  );
}

function supportedZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
      "timeZone",
    );
  } catch {
    return [];
  }
}

export function TimezoneSelect({
  id,
  value,
  onChange,
  onBlur,
  describedBy,
  invalid,
}: {
  id: string;
  value: string;
  onChange(zone: string): void;
  onBlur?(): void;
  describedBy?: string | undefined;
  invalid?: boolean;
}) {
  return (
    <NativeSelect
      id={id}
      value={value}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-label={`Time zone, ${value}`}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    >
      {zoneGroups(value).map((g) => (
        <optgroup key={g.region} label={g.region}>
          {g.zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}
