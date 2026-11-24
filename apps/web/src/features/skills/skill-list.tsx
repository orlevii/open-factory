import type { RowState as RowStateName, SkillGroupsResponse } from "@open-factory/shared";
import { rowStateOf } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, memo, useId, useRef } from "react";
import { ErrorLine } from "@/components/error-line";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Skeleton } from "@/components/ui/skeleton";
import { UntrustedProse, visibleControls } from "@/components/untrusted-text";
import { FORM_MSG } from "@/lib/form-messages";
import { libraryQueryOptions } from "@/lib/library";
import { onRowKeyDown } from "@/lib/row-nav";
import { runInstantOn } from "@/lib/run-instant";
import { shouldIgnore } from "@/lib/shortcuts";
import type { Arrival } from "@/lib/use-arrival";
import { count, pinLabel, sourceLabel, usedByText } from "./format";
import { RowState } from "./row-state";
import { type PeekControl, skillKey, sourceKey } from "./use-peek";

type Group = SkillGroupsResponse["groups"][number];

/** The row's bar: one 2.75rem row, its facts spaced by `gap-x-4` and wrapping between them. */
const ROW =
  "of-row flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-0.5 px-2 py-2 text-left text-sm @min-[60rem]:flex-nowrap @min-[60rem]:py-0";

const POPUP = { "aria-haspopup": "dialog" } as const;

/** The tint only the arrived row carries; it fades out and `onArrivedEnd` clears it. */
function arrivalProps(arrival: Arrival | undefined, onArrivedEnd: () => void) {
  return arrival
    ? {
        "data-arrived": arrival === "fading" ? "fading" : "",
        onTransitionEnd: (e: React.TransitionEvent) => {
          if (e.target !== e.currentTarget || arrival !== "fading") return;
          if (e.propertyName && e.propertyName !== "opacity") return;
          onArrivedEnd();
        },
      }
    : {};
}

type RowProps = {
  selected: boolean;
  arrival: Arrival | undefined;
  onArrivedEnd(): void;
  onOpen(key: string): void;
};

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
      className={`${ROW} border-b border-border font-medium`}
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
function PlainHeader({ labelId, children }: { labelId: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-border px-2 py-2 text-sm font-medium">
      <span id={labelId}>{children}</span>
    </div>
  );
}

const inGroup = (g: Group, key: string | null | undefined) =>
  key != null &&
  (key.startsWith(`skill:${g.group}/`) || (g.kind === "source" && key === sourceKey(g.source.id)));

type GroupProps = {
  g: Group;
  hostDir: string;
  /** The peek's key, only when it is in this group (so another group's retarget doesn't re-render this one). */
  shownKey: string | null;
  arrivedKey: string | undefined;
  arrival: Arrival | undefined;
  onArrivedEnd(): void;
  onOpen(key: string): void;
};

const GroupSection = memo(function GroupSection({
  g,
  hostDir,
  shownKey,
  arrivedKey,
  arrival,
  onArrivedEnd,
  onOpen,
}: GroupProps) {
  const labelId = useId();
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
        <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-border px-2 py-2 text-sm">
          <span id={labelId} className="font-medium">
            Host
          </span>
          <span className="flex min-w-0 flex-1 font-mono text-[0.8125rem] text-muted-foreground">
            <MiddleTruncate text={`${hostDir.replace(/\/$/, "")}/skills`} />
          </span>
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
        <PlainHeader labelId={labelId}>
          Template <span className="font-mono text-[0.8125rem]">{g.template}</span>
        </PlainHeader>
      );
      break;
    case "unknown":
      header = <PlainHeader labelId={labelId}>Unknown</PlainHeader>;
      break;
  }
  return (
    <section>
      {header}
      {g.skills.length > 0 && (
        <ul aria-labelledby={labelId}>
          {g.skills.map((s) => (
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

/** Static skeleton rows at their real height (2.75rem), hoisted so they never re-render. */
const SKELETON = (
  <div aria-hidden="true" className="border-y border-border">
    {[0, 1, 2, 3].map((i) => (
      <div key={i} className="flex h-11 items-center px-2">
        <Skeleton className="h-4 w-48" />
      </div>
    ))}
  </div>
);

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
  const list = useRef<HTMLDivElement>(null);
  const data = q.data;
  const rowKeyOf = (el: EventTarget) =>
    el instanceof HTMLElement ? el.dataset.peekKey : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = onRowKeyDown(e);
    const el = list.current;
    if (!el) return;
    if (row && peek.key !== null && (e.key === "j" || e.key === "k")) {
      const key = row.dataset.peekKey;
      if (key && key !== peek.key) runInstantOn(el, () => peek.show(key));
      return;
    }
    if (e.key === "F6" && peek.key !== null) {
      e.preventDefault();
      peek.focus();
      return;
    }
    const key = e.key === " " ? rowKeyOf(e.target) : undefined;
    if (!key || shouldIgnore(e.nativeEvent)) return;
    // Space acts on keydown (and its keyup is cancelled below), so it never also clicks: on the shown row it closes
    // the peek; on another it opens or retargets it.
    e.preventDefault();
    if (peek.key === key) peek.close();
    else runInstantOn(el, () => peek.show(key));
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " " && rowKeyOf(e.target)) e.preventDefault();
  };

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
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys are the rows' own (j/k, Space, F6), caught at the list
    <div
      ref={list}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className="@container border-y border-border [overflow-anchor:auto]"
    >
      {data.groups.map((g) => (
        <GroupSection
          key={g.group}
          g={g}
          hostDir={data.hostDir}
          shownKey={inGroup(g, peek.key) ? peek.key : null}
          arrivedKey={inGroup(g, arrivedKey) ? arrivedKey : undefined}
          arrival={inGroup(g, arrivedKey) ? arrival : undefined}
          onArrivedEnd={onArrivedEnd}
          onOpen={peek.show}
        />
      ))}
    </div>
  );
}
