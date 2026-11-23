import { PLUGIN_REF } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { memo, useMemo } from "react";
import type { ComboOption } from "@/components/ui/combobox";
import { hostSkillsQueryOptions } from "./api";
import type { AddSlot } from "./config-list";
import { FIELD_PATHS } from "./fields";
import { ListField } from "./list-field";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";
import { PickAdd, pickEmpty } from "./pick-add";
import { useConfigScope } from "./scope";
import { Section } from "./section";
import { readAt, readList } from "./tolerant";

const checkPlugin = (v: string) => (PLUGIN_REF.test(v) ? undefined : CONFIG_FIELD_MSG.pluginRef);

const renderSkill = (o: ComboOption) => (
  <>
    <span className="font-mono text-[0.8125rem]">{o.label}</span>
    {o.keywords?.[0] ? <span className="ml-2 text-muted-foreground">{o.keywords[0]}</span> : null}
  </>
);

const NO_SKILLS: readonly string[] = [];

/** Spec §12.2 section 2: host skills from a picker, the template's own skills read-only, and plugins. */
export function SkillsSection({ localSkills = NO_SKILLS }: { localSkills?: readonly string[] }) {
  const { mode } = useConfigScope();
  return (
    <Section title="Skills and plugins">
      <ListField
        field="skills"
        label="Skills"
        noun="skill"
        mono
        lead={localSkills.length > 0 ? <LocalSkills names={localSkills} /> : null}
        renderAdd={(slot) => <SkillPicker slot={slot} localSkills={localSkills} />}
      />
      <ListField
        field="plugins"
        label="Plugins"
        noun="plugin"
        mono
        placeholder="formatter@acme"
        help={mode === "agent" ? CONFIG_COPY.pluginsHelpAgent : CONFIG_COPY.pluginsHelpTemplate}
        check={checkPlugin}
      />
    </Section>
  );
}

/** The template's own `skills/` folders: always loaded, edited in the template's files, never here. */
const LocalSkills = memo(function LocalSkills({ names }: { names: readonly string[] }) {
  return (
    <ul aria-label={CONFIG_COPY.templateSkill} className="grid">
      {names.map((n) => (
        <li key={n} className="flex min-h-8 items-start gap-2 px-2 pointer-coarse:min-h-10">
          <span className="min-w-0 flex-1 py-1.5 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
            {n}
          </span>
          <span className="shrink-0 py-1.5 text-[0.8125rem] text-muted-foreground">
            {CONFIG_COPY.templateSkill}
          </span>
        </li>
      ))}
    </ul>
  );
});

function SkillPicker({ slot, localSkills }: { slot: AddSlot; localSkills: readonly string[] }) {
  const q = useQuery(hostSkillsQueryOptions);
  const { value, base } = useConfigScope();
  const own = readList(readAt(value, FIELD_PATHS.skills));
  const inherited = base ? readList(readAt(base, FIELD_PATHS.skills)) : null;
  const ownItems = own.ok ? own.items : NO_SKILLS;
  const tplItems = inherited?.ok ? inherited.items : NO_SKILLS;
  const options = useMemo(() => {
    // Already listed, or a template skill of the same name (the server refuses that clash): not offered.
    const taken = new Set([...ownItems, ...tplItems, ...localSkills]);
    return (q.data?.skills ?? [])
      .filter((s) => !taken.has(s.name))
      .map((s): ComboOption => ({ value: s.name, label: s.name, keywords: [s.description] }));
  }, [q.data, ownItems, tplItems, localSkills]);
  return (
    <PickAdd
      slot={slot}
      label="Add skill"
      placeholder="Add a host skill"
      options={options}
      emptyText={pickEmpty(q, "No more host skills.")}
      renderOption={renderSkill}
    />
  );
}
