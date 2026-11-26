import type { RowState as RowStateName, SkillGroupsResponse } from "@open-factory/shared";
import { rowStateOf } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { memo, useCallback, useDeferredValue, useId, useMemo, useState } from "react";
import { ErrorLine } from "@/components/error-line";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Input } from "@/components/ui/input";
import { UntrustedProse, visibleControls } from "@/components/untrusted-text";
import { FORM_MSG } from "@/lib/form-messages";
import { libraryQueryOptions } from "@/lib/library";
import { usePref } from "@/lib/prefs";
import type { Arrival } from "@/lib/use-arrival";
import { cn } from "@/lib/utils";
import { count, pinLabel, sourceLabel, usedByText } from "./format";
import { arrivalProps, POPUP, ROW, type RowProps, SKELETON, useRowKeys } from "./list-parts";
import { RowState } from "./row-state";
import { type PeekControl, skillKey, sourceKey } from "./use-peek";

type Group = SkillGroupsResponse["groups"][number];

/** A skill's own state: `ok` shows none. */
const skillState = (s: "ok" | "missing" | "hidden" | "unusable"): RowStateName | undefined =>
  s === "ok" ? undefined : s;

const SkillRow = memo(function SkillRow({
  group,
  name,
  description,
  state,
  templates,
  agents,
  selected,
  arrival,
  onArrivedEnd,
  onOpen,
}: RowProps & {
  group: string;
  name: string;
  description: string;
  state: RowStateName | undefined;
  templates: number;
  agents: number;
}) {
  const key = skillKey(group, name);
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        data-row=""
        data-peek-key={key}
        {...POPUP}
        aria-expanded={selected}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(key)}
        className={ROW}
        {...arrivalProps(arrival, onArrivedEnd)}
      >
        <span className="min-w-0 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
          <UntrustedProse text={name} />
        </span>
        {/* The description is the first thing to go on narrow screens. */}
        <span className="hidden min-w-0 flex-1 truncate text-muted-foreground @min-[60rem]:block">
          <UntrustedProse text={description} />
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {usedByText(templates, agents)}
        </span>
        {state && <RowState state={state} />}
      </button>
    </li>
  );
});

type SourceGroup = Extract<Group, { kind: "source" }>;

/** A source header's one state, by precedence. */
function sourceState(s: SourceGroup["source"]): RowStateName | undefined {
  return rowStateOf([
    ...(s.state === "adding" ? (["adding"] as const) : []),
    ...(s.checking ? (["checking"] as const) : []),
    ...(s.checkFailed ? (["check_failed"] as const) : []),
    ...(s.update ? (["update"] as const) : []),
  ]);
}

/** The server's `since` for a pending state, which a row shows as elapsed time after 10 s. */
const pendingSince = (s: SourceGroup["source"], state: RowStateName | undefined) =>
  state === "adding"
    ? (s.since ?? undefined)
    : state === "checking"
      ? s.checking?.since
      : undefined;

/** The source header: a button that opens the Source peek. Its name span labels the group's `ul`. */
const SourceHeader = memo(function SourceHeader({
  labelId,
  id,
  label,
  pin,
  skillCount,
  state,
  since,
  selected,
  arrival,
  onArrivedEnd,
  onOpen,
}: RowProps & {
  labelId: string;
  id: string;
  label: string;
  pin: string | undefined;
  skillCount: number;
  state: RowStateName | undefined;
  since: string | undefined;
}) {
  const key = sourceKey(id);
  return (
    <button
      type="button"
      data-row=""
      data-peek-key={key}
      data-update={state === "update" ? "" : undefined}
      {...POPUP}
      aria-expanded={selected}
      aria-current={selected ? "true" : undefined}
      onClick={() => onOpen(key)}
      className={`${ROW} font-medium`}
      {...arrivalProps(arrival, onArrivedEnd)}
    >
      <span id={labelId} className="flex min-w-0 flex-1 font-mono text-[0.8125rem]">
        <MiddleTruncate text={visibleControls(label)} />
      </span>
      {pin && (
        <span className="font-mono text-[0.8125rem] font-normal text-muted-foreground">{pin}</span>
      )}
      <span className="font-normal text-muted-foreground">{count(skillCount, "skill")}</span>
      {state && <RowState state={state} since={since} />}
    </button>
  );
});

/** Host, Template and Unknown headers: plain text, no peek and no actions. */
function PlainHeader({
  labelId,
  count,
  children,
}: {
  labelId: string;
  count: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 px-2 py-2 text-sm font-medium">
      <span id={labelId}>{children}</span>
      {count}
    </div>
  );
}

const inGroup = (g: Group, key: string | null | undefined) =>
  key != null &&
  (key.startsWith(`skill:${g.group}/`) || (g.kind === "source" && key === sourceKey(g.source.id)));

type GroupProps = {
  g: Group;
  /** The group's skills to list: all of them, or the ones matching the filter. */
  skills: Group["skills"];
  hostDir: string;
  /** Collapsed: only the header shows. A filter, or a peek or arrival inside the group, keeps it open. */
  collapsed: boolean;
  onToggle(group: string): void;
  /** The peek's key, only when it is in this group (so another group's retarget doesn't re-render this one). */
  shownKey: string | null;
  arrivedKey: string | undefined;
  arrival: Arrival | undefined;
  onArrivedEnd(): void;
  onOpen(key: string): void;
};

const GroupSection = memo(function GroupSection({
  g,
  skills,
  hostDir,
  collapsed,
  onToggle,
  shownKey,
  arrivedKey,
  arrival,
  onArrivedEnd,
  onOpen,
}: GroupProps) {
  const labelId = useId();
  const listId = useId();
  // The chevron turns only when its own click toggled it; a keyboard toggle is instant (DESIGN.md → Motion).
  const [pointerToggled, setPointerToggled] = useState(false);
  const skillCount = (
    <span className="text-[0.8125rem] font-normal text-muted-foreground">
      {count(g.skills.length, "skill")}
    </span>
  );
  const tint = (key: string) => ({
    selected: shownKey === key,
    arrival: arrivedKey === key ? arrival : undefined,
    onArrivedEnd,
    onOpen,
  });
  let header: React.ReactNode;
  switch (g.kind) {
    case "host":
      header = (
        <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 px-2 py-2 text-sm">
          <span id={labelId} className="font-medium">
            Host
          </span>
          <span className="flex min-w-0 flex-1 font-mono text-[0.8125rem] text-muted-foreground">
            <MiddleTruncate text={`${hostDir.replace(/\/$/, "")}/skills`} />
          </span>
          {skillCount}
          <span className="text-[0.8125rem] text-muted-foreground">Live</span>
        </div>
      );
      break;
    case "source": {
      const s = g.source;
      const state = sourceState(s);
      header = (
        <SourceHeader
          labelId={labelId}
          id={s.id}
          label={sourceLabel(s)}
          pin={pinLabel(s)}
          skillCount={s.skillCount}
          state={state}
          since={pendingSince(s, state)}
          {...tint(sourceKey(s.id))}
        />
      );
      break;
    }
    case "template":
      header = (
        <PlainHeader labelId={labelId} count={skillCount}>
          Template <span className="font-mono text-[0.8125rem]">{g.template}</span>
        </PlainHeader>
      );
      break;
    case "unknown":
      header = (
        <PlainHeader labelId={labelId} count={skillCount}>
          Unknown
        </PlainHeader>
      );
      break;
  }
  const canToggle = g.skills.length > 0;
  return (
    <section>
      <div className="flex items-stretch border-b border-border">
        {canToggle ? (
          <button
            type="button"
            aria-label={`Skills in ${groupName(g)}`}
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : listId}
            data-toggled={pointerToggled ? "pointer" : undefined}
            onClick={(e) => {
              // `detail` is 0 for a click from the keyboard (Enter or Space on the button).
              setPointerToggled(e.detail > 0);
              onToggle(g.group);
            }}
            className={cn(
              "of-row flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground",
              "data-[toggled=pointer]:[&>svg]:transition-transform data-[toggled=pointer]:[&>svg]:duration-150 data-[toggled=pointer]:[&>svg]:ease-(--ease-out) motion-reduce:[&>svg]:transition-none",
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("size-3.5", !collapsed && "rotate-90")}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="w-8 shrink-0" />
        )}
        <div className="min-w-0 flex-1">{header}</div>
      </div>
      {!collapsed && skills.length > 0 && (
        <ul id={listId} aria-labelledby={labelId}>
          {skills.map((s) => (
            <SkillRow
              key={s.name}
              group={g.group}
              name={s.name}
              description={s.description}
              state={skillState(s.state)}
              templates={s.usedBy.templates}
              agents={s.usedBy.agents}
              {...tint(skillKey(g.group, s.name))}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

/** Groups the user collapsed, remembered per browser: group id → true. */
const COLLAPSED_KEY = "of-skills-collapsed";
const NO_COLLAPSED: Record<string, boolean> = {};

function parseCollapsed(raw: string): Record<string, boolean> | undefined {
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return Object.fromEntries(Object.entries(v).filter(([, b]) => b === true));
}

/** What a group's header names: the collapse toggle's name, and the filter's (a match there lists the whole group). */
function groupName(g: Group): string {
  switch (g.kind) {
    case "host":
      return "Host";
    case "source":
      return visibleControls(sourceLabel(g.source));
    case "template":
      return `Template ${g.template}`;
    case "unknown":
      return "Unknown";
  }
}

/**
 * The groups to show for a filter (already trimmed and lower-case): with none, every group and skill. Otherwise a
 * skill shows when its name or description holds the filter, a group whose header does shows all of its skills,
 * and a group with nothing to show is left out.
 */
function filterGroups(groups: Group[], q: string) {
  if (!q) return groups.map((g) => ({ g, skills: g.skills }));
  return groups.flatMap((g) => {
    if (groupName(g).toLowerCase().includes(q))
      return g.skills.length > 0 ? [{ g, skills: g.skills }] : [];
    const skills = g.skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
    return skills.length > 0 ? [{ g, skills }] : [];
  });
}

/** Whether a group holds nothing to show: the Host group is always there, so an empty library has only it. */
const isEmpty = (data: SkillGroupsResponse) =>
  data.groups.every((g) => g.kind !== "source" && g.skills.length === 0);

/**
 * The Skills view (spec §10.2): groups in the server's order (Host, each source, Template `x`, Unknown), each its own
 * `ul` labelled by its header's name. Rows and source headers are buttons that open a peek; `j`/`k` (the shared
 * `onRowKeyDown`, by `data-row`) move between them and retarget an open peek, Space on the shown row closes it, F6 moves
 * into the peek.
 */
export function SkillList({
  peek,
  arrivedKey,
  arrival,
  onArrivedEnd,
}: {
  peek: PeekControl;
  arrivedKey: string | undefined;
  arrival: Arrival | undefined;
  onArrivedEnd(): void;
}) {
  const q = useQuery(libraryQueryOptions);
  const { list, onKeyDown, onKeyUp } = useRowKeys(peek);
  const data = q.data;
  const [query, setQuery] = useState("");
  // Typing stays responsive on a long Library: the list filters at the deferred value.
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [collapsedGroups, setCollapsed] = usePref(
    COLLAPSED_KEY,
    NO_COLLAPSED,
    parseCollapsed,
    JSON.stringify,
  );
  const onToggle = useCallback(
    (group: string) => {
      const { [group]: was, ...rest } = collapsedGroups;
      setCollapsed(was ? rest : { ...rest, [group]: true });
    },
    [collapsedGroups, setCollapsed],
  );
  const shown = useMemo(() => (data ? filterGroups(data.groups, deferred) : []), [data, deferred]);

  if (!data)
    return q.isError ? (
      <ErrorLine text={FORM_MSG.loadSkills} onRetry={() => void q.refetch()} />
    ) : (
      SKELETON
    );
  if (isEmpty(data))
    return (
      <p className="text-sm text-muted-foreground">
        No skills yet. Add some, or put a folder in{" "}
        <code className="font-mono text-[0.8125rem]">{data.hostDir.replace(/\/$/, "")}/skills</code>
        .
      </p>
    );
  return (
    <div className="grid gap-3">
      <Input
        type="search"
        aria-label="Search skills"
        placeholder="Search skills"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        className="h-9 max-w-sm"
      />
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{FORM_MSG.noMatches}</p>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: the keys are the rows' own (j/k, Space, F6), caught at the list
        <div
          ref={list}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          className="@container border-y border-border [overflow-anchor:auto]"
        >
          {shown.map(({ g, skills }) => (
            <GroupSection
              key={g.group}
              g={g}
              skills={skills}
              collapsed={
                !deferred &&
                collapsedGroups[g.group] === true &&
                !inGroup(g, peek.key) &&
                !inGroup(g, arrivedKey)
              }
              onToggle={onToggle}
              hostDir={data.hostDir}
              shownKey={inGroup(g, peek.key) ? peek.key : null}
              arrivedKey={inGroup(g, arrivedKey) ? arrivedKey : undefined}
              arrival={inGroup(g, arrivedKey) ? arrival : undefined}
              onArrivedEnd={onArrivedEnd}
              onOpen={peek.show}
            />
          ))}
        </div>
      )}
    </div>
  );
}
