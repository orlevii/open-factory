import {
  PLUGIN_REF_PATTERN,
  type RowState as RowStateName,
  type SkillGroupsResponse,
} from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import type { ComboOption } from "@/components/ui/combobox";
import { UntrustedProse } from "@/components/untrusted-text";
import { count, pinLabel, sourceLabel } from "@/features/skills/format";
import { RowState } from "@/features/skills/row-state";
import { libraryQueryOptions } from "@/lib/library";
import type { AddSlot } from "./config-list";
import { FIELD_PATHS } from "./fields";
import { ListField } from "./list-field";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";
import { PickAddMany, pickEmpty } from "./pick-add";
import { useConfigScope } from "./scope";
import { Section } from "./section";
import { readAt, readList } from "./tolerant";

const checkPlugin = (v: string) =>
  PLUGIN_REF_PATTERN.test(v) ? undefined : CONFIG_FIELD_MSG.pluginRef;

/** Two lines (spec §10.5): the name (mono, wraps), then the description, muted, one line. */
const renderSkill = (o: ComboOption) => (
  <span className="grid min-w-0">
    <span className="font-mono text-[0.8125rem] whitespace-normal [overflow-wrap:anywhere]">
      {o.label}
    </span>
    {o.keywords?.[0] ? (
      <span className="truncate text-xs text-muted-foreground">
        <UntrustedProse text={o.keywords[0]} />
      </span>
    ) : null}
  </span>
);

/** A group's heading: a source's path or repo is long, so it truncates in the middle. */
const renderGroup = (group: string) => <MiddleTruncate text={group} />;

const NO_SKILLS: readonly string[] = [];

type Where = { tag: string | undefined; state: RowStateName | undefined };

/** Name to where it comes from and its state, over every group a skill can be listed in. A usable entry wins a clash. */
function whereByName(data: SkillGroupsResponse | undefined): ReadonlyMap<string, Where> {
  const m = new Map<string, Where & { ok: boolean }>();
  for (const g of data?.groups ?? []) {
    if (g.kind === "template") continue;
    const tag =
      g.kind === "host"
        ? "Host"
        : g.kind === "source"
          ? [g.source.kind === "github" ? "GitHub" : "Folder", pinLabel(g.source)]
              .filter(Boolean)
              .join(" · ")
          : undefined;
    for (const s of g.skills) {
      if (m.get(s.name)?.ok) continue;
      m.set(s.name, { tag, state: s.state === "ok" ? undefined : s.state, ok: s.state === "ok" });
    }
  }
  return m;
}

/**
 * The Library list is in the cache from the route's prefetch (R-B1), so the section never starts a fetch on mount; with
 * an empty cache it fetches once. Window focus and `library_changed` keep it current.
 */
const pickerQuery = { ...libraryQueryOptions, refetchOnMount: false } as const;

const NO_LIST: ReadonlyMap<string, Where> = new Map();

/** Spec §12.2 section 2: host skills from a picker, the template's own skills read-only, and plugins. */
export function SkillsSection({ localSkills = NO_SKILLS }: { localSkills?: readonly string[] }) {
  const { mode } = useConfigScope();
  const q = useQuery(pickerQuery);
  const where = useMemo(() => (q.data ? whereByName(q.data) : NO_LIST), [q.data]);
  // Stable while the Library list is: the rows are memoised.
  const format = useCallback(
    (name: string) => <SkillRowText name={name} where={where.get(name)} />,
    [where],
  );
  return (
    <Section title="Skills and plugins">
      <ListField
        field="skills"
        label="Skills"
        noun="skill"
        mono
        lead={localSkills.length > 0 ? <LocalSkills names={localSkills} /> : null}
        format={format}
        labelAction={(slot) => (
          <SkillPicker
            slot={slot}
            localSkills={localSkills}
            data={q.data}
            isPending={q.isPending}
            isError={q.isError}
          />
        )}
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

/** A selected row (spec §10.5): the name, where it comes from and its pin ("GitHub · a1b2c3d"), and any state. */
const SkillRowText = memo(function SkillRowText({
  name,
  where,
}: {
  name: string;
  where: Where | undefined;
}) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="min-w-0 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">{name}</span>
      {where?.tag ? (
        <span className="text-[0.8125rem] text-muted-foreground">{where.tag}</span>
      ) : null}
      {where?.state ? <RowState state={where.state} /> : null}
    </span>
  );
});

const NO_OPTIONS: ComboOption[] = [];

/**
 * The skills a start can use and this template doesn't already own: hidden, unusable and missing ones are left out.
 * `leftOut` counts names, not entries: a name offered as usable from any group (the `whereByName` rule) isn't left out.
 */
function pickable(data: SkillGroupsResponse | undefined, local: ReadonlySet<string>) {
  const options: ComboOption[] = [];
  const usable = new Set<string>();
  const unusable = new Set<string>();
  for (const g of data?.groups ?? []) {
    if (g.kind === "template" || g.kind === "unknown") continue;
    const group = g.kind === "host" ? "Host" : sourceLabel(g.source);
    for (const s of g.skills) {
      if (local.has(s.name)) continue;
      if (s.state !== "ok") unusable.add(s.name);
      else {
        usable.add(s.name);
        options.push({ value: s.name, label: s.name, keywords: [s.description], group });
      }
    }
  }
  const leftOut = [...unusable].filter((n) => !usable.has(n)).length;
  return { options, leftOut };
}

function SkillPicker({
  slot,
  localSkills,
  data,
  isPending,
  isError,
}: {
  slot: AddSlot;
  localSkills: readonly string[];
  data: SkillGroupsResponse | undefined;
  isPending: boolean;
  isError: boolean;
}) {
  const { value, base } = useConfigScope();
  const own = readList(readAt(value, FIELD_PATHS.skills));
  const inherited = base ? readList(readAt(base, FIELD_PATHS.skills)) : null;
  const picked = [
    ...(own.ok ? own.items : NO_SKILLS),
    ...(inherited?.ok ? inherited.items : NO_SKILLS),
  ];
  // Template-local names are a primitive key too: `localSkills` may be a fresh array each render.
  const localKey = localSkills.join("\0");
  const { options, leftOut } = useMemo(
    () => pickable(data, new Set(localKey ? localKey.split("\0") : [])),
    [data, localKey],
  );
  const emptyText =
    isError || isPending
      ? pickEmpty({ isPending, isError }, "")
      : options.length === 0
        ? CONFIG_COPY.noSkills
        : CONFIG_COPY.allSkillsAdded;
  return (
    <PickAddMany
      slot={slot}
      label="Add skill"
      options={isError || isPending ? NO_OPTIONS : options}
      emptyText={emptyText}
      renderOption={renderSkill}
      renderGroup={renderGroup}
      picked={picked}
      footer={
        leftOut > 0 ? (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {count(leftOut, "skill")} can't be used here: hidden or unusable.
          </p>
        ) : undefined
      }
      trigger={
        <Button
          type="button"
          variant="ghost"
          inForm
          id={slot.id}
          aria-describedby={slot.describedBy}
          aria-invalid={slot.invalid || undefined}
        >
          <Plus aria-hidden="true" data-icon="inline-start" />
          Add skill
        </Button>
      }
    />
  );
}
