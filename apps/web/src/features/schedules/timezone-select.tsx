import { useMemo, useState } from "react";
import { Combobox, type ComboOption } from "@/components/ui/combobox";

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

const offsets = new Map<string, string>();

/** "GMT+9", "GMT-5", "GMT" for a zone right now. Cached per zone for the page's life (an offset can
 *  change with daylight saving, but a typeahead keyword only needs to be close). "" for an unknown zone. */
export function zoneOffset(zone: string): string {
  const hit = offsets.get(zone);
  if (hit !== undefined) return hit;
  let offset = "";
  try {
    offset =
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    // An unknown zone has no offset; it stays searchable by name.
  }
  offsets.set(zone, offset);
  return offset;
}

export function TimezoneSelect({
  id,
  value,
  onChange,
  describedBy,
  invalid,
}: {
  id: string;
  value: string;
  onChange(zone: string): void;
  describedBy?: string | undefined;
  invalid?: boolean;
}) {
  // Offsets (about 400 formatter calls the first time) wait for the first open.
  const [opened, setOpened] = useState(false);
  const options = useMemo<ComboOption[]>(
    () =>
      zoneGroups(value).flatMap((g) =>
        g.zones.map((z) => ({
          value: z,
          label: z,
          group: g.region,
          keywords: [
            z,
            z.replaceAll("_", " ").replaceAll("/", " "),
            ...(opened ? [zoneOffset(z)] : []),
          ],
        })),
      ),
    [value, opened],
  );
  return (
    <Combobox
      id={id}
      value={value}
      onValueChange={onChange}
      options={options}
      onOpen={() => setOpened(true)}
      emptyText="No time zone matches."
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-label={`Time zone, ${value}`}
    />
  );
}
