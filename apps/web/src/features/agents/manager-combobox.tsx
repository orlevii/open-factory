import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo } from "react";
import { AgentChip } from "@/components/agent-chip";
import { HumanAvatar } from "@/components/human-avatar";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { useAgent } from "@/features/agents/use-agent-index";
import { agentsListQueryOptions } from "@/features/session/api";
import { usersQueryOptions } from "@/features/settings/api";
import { sessionQueryOptions } from "@/lib/session";

const PEOPLE = "People";
const AGENTS = "Agents";

type Person = { handle: string; name: string; you: boolean };

/** Persistent, live agents, in the reporting tree's order (the server's). */
const managersInTree = (data: AgentSummary[]) =>
  data
    .filter((a) => a.kind === "persistent" && !a.archivedAt && !a.terminatedAt)
    .map((a) => ({ slug: a.slug, displayName: a.displayName }));
const liveHandles = (data: AgentSummary[]) =>
  new Set(data.filter((a) => !a.archivedAt && !a.terminatedAt).map((a) => a.slug));

const NO_AGENTS: { slug: string; displayName: string }[] = [];

/** The person's name and handle, as a chip. "You (Or Levi · @or)" for the signed-in human. */
function PersonChip({ person }: { person: Person }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <HumanAvatar name={person.name} />
      {person.you ? (
        <span dir="auto" className="min-w-0 truncate">
          You ({person.name} · @{person.handle})
        </span>
      ) : (
        <>
          <span dir="auto" className="min-w-0 truncate">
            {person.name}
          </span>
          <span className="flex min-w-0 shrink-[2] font-mono text-xs text-muted-foreground">
            <MiddleTruncate text={`@${person.handle}`} />
          </span>
        </>
      )}
    </span>
  );
}

/** Reporting-line depth as padding: 0.75rem a level, three levels at most, then a `└ `. */
function AgentRow({ slug }: { slug: string }) {
  const depth = useAgent(slug)?.depth ?? 0;
  return (
    <span
      className="flex min-w-0 items-center gap-1"
      style={{ paddingInlineStart: `${Math.min(depth, 3) * 0.75}rem` }}
    >
      {depth > 3 && <span aria-hidden="true">└</span>}
      <AgentChip slug={slug} badge showSlug />
    </span>
  );
}

/**
 * The Manager pick of New agent and Edit agent: "People" first (you at the top, then the other enabled users), then
 * "Agents" in tree order. Filtering matches a name or a handle, with or without the `@`. A disabled user is left out;
 * a saved manager that is disabled or archived stays shown, named as such. If the users list fails, the agents and
 * you (from the session) are still pickable. `canManage` leaves agents out (Edit: itself and everything under it).
 */
export function ManagerCombobox({
  value,
  onValueChange,
  canManage,
  id,
  disabled,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  value: string;
  onValueChange(handle: string): void;
  /** A stable predicate over an agent's slug. */
  canManage?: (slug: string) => boolean;
  id?: string;
  disabled?: boolean;
  "aria-label": string;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}) {
  const agents = useQuery({ ...agentsListQueryOptions("exclude"), select: managersInTree });
  const live = useQuery({ ...agentsListQueryOptions("exclude"), select: liveHandles });
  const users = useQuery(usersQueryOptions);
  const session = useQuery(sessionQueryOptions).data?.user;
  const meHandle = session?.handle;
  const meName = session?.name;

  const people = useMemo((): Person[] => {
    const others = (users.data ?? [])
      .filter((u) => !u.disabledAt && u.handle !== meHandle)
      .map((u) => ({ handle: u.handle, name: u.name, you: false }));
    if (!meHandle) return others;
    // You come from the session, so the pick works while the users list is loading or has failed.
    const mine = users.data?.find((u) => u.handle === meHandle);
    return [{ handle: meHandle, name: mine?.name ?? meName ?? "", you: true }, ...others];
  }, [users.data, meHandle, meName]);
  const peopleByHandle = useMemo(
    () => new Map(people.map((p) => [p.handle, p] as const)),
    [people],
  );

  const options = useMemo((): ComboOption[] => {
    const manageable = (agents.data ?? NO_AGENTS).filter((a) => !canManage || canManage(a.slug));
    return [
      ...people.map(
        (p): ComboOption => ({
          value: p.handle,
          label: p.you ? `You (${p.name} · @${p.handle})` : p.name,
          keywords: [p.handle],
          group: PEOPLE,
        }),
      ),
      ...manageable.map(
        (a): ComboOption => ({
          value: a.slug,
          label: a.displayName || a.slug,
          keywords: [a.slug],
          group: AGENTS,
        }),
      ),
    ];
  }, [people, agents.data, canManage]);

  const disabledHandles = useMemo(
    () => new Set((users.data ?? []).filter((u) => u.disabledAt).map((u) => u.handle)),
    [users.data],
  );
  const renderOption = useCallback(
    (o: ComboOption): ReactNode => {
      const p = o.group === PEOPLE ? peopleByHandle.get(o.value) : undefined;
      return p ? <PersonChip person={p} /> : <AgentRow slug={o.value} />;
    },
    [peopleByHandle],
  );
  const renderValue = useCallback(
    (v: string): ReactNode => {
      const p = peopleByHandle.get(v);
      if (p) return <PersonChip person={p} />;
      if (disabledHandles.has(v)) return `@${v} (disabled)`;
      if (live.data?.has(v) && (!canManage || canManage(v)))
        return <AgentChip slug={v} badge showSlug inline />;
      // Archived only once both lists have answered: a loading or failed list says nothing about the handle.
      return live.data && users.data ? `@${v} (archived)` : `@${v}`;
    },
    [peopleByHandle, disabledHandles, live.data, users.data, canManage],
  );

  return (
    <Combobox
      value={value}
      onValueChange={onValueChange}
      options={options}
      emptyText="No one matches."
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      id={id}
      disabled={disabled || !agents.data}
      renderOption={renderOption}
      renderValue={renderValue}
    />
  );
}
