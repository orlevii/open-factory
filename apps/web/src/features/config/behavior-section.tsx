import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ComboOption } from "@/components/ui/combobox";
import { templatesQueryOptions } from "@/features/templates/api";
import type { AddSlot } from "./config-list";
import { FIELD_PATHS } from "./fields";
import { ListField } from "./list-field";
import { NumberField } from "./number-field";
import { PickAdd, pickEmpty } from "./pick-add";
import { useConfigScope } from "./scope";
import { Section } from "./section";
import { readAt, readList } from "./tolerant";

/** What applies when nothing sets them: the runtime's warm window and the template schema's default. */
const WARM_WINDOW_DEFAULT = 70;
const NONE: readonly string[] = [];

/** Spec §12.2 section 6: warm window and spawnable templates (a multi-select of template names). */
export function BehaviorSection() {
  return (
    <Section title="Behavior">
      <NumberField
        field="warmWindow"
        label="Warm window"
        unit="minutes"
        fallback={WARM_WINDOW_DEFAULT}
      />
      <ListField
        field="canSpawn"
        label="Spawnable templates"
        noun="spawnable template"
        mono
        renderAdd={(slot) => <TemplatePicker slot={slot} />}
      />
    </Section>
  );
}

function TemplatePicker({ slot }: { slot: AddSlot }) {
  const q = useQuery(templatesQueryOptions);
  const { value, base } = useConfigScope();
  const own = readList(readAt(value, FIELD_PATHS.canSpawn));
  const tpl = base ? readList(readAt(base, FIELD_PATHS.canSpawn)) : null;
  const ownItems = own.ok ? own.items : NONE;
  const tplItems = tpl?.ok ? tpl.items : NONE;
  const options = useMemo(() => {
    const taken = new Set([...ownItems, ...tplItems]);
    return (q.data?.templates ?? [])
      .filter((t) => !taken.has(t.name))
      .map(
        (t): ComboOption => ({
          value: t.name,
          label: t.name,
          keywords: t.displayName ? [t.displayName] : [],
        }),
      );
  }, [q.data, ownItems, tplItems]);
  return (
    <PickAdd
      slot={slot}
      label="Add spawnable template"
      placeholder="Add a template"
      options={options}
      emptyText={pickEmpty(q, "No more templates.")}
    />
  );
}
