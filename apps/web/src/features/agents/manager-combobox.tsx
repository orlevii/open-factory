import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo } from "react";
import { AgentChip } from "@/components/agent-chip";
import { HumanAvatar } from "@/components/human-avatar";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { useAgent } from "@/features/agents/use-agent-index";
import { usePrincipal } from "@/features/principals/use-principal";
import { agentsListQueryOptions } from "@/features/session/api";
import { usersQueryOptions } from "@/features/settings/api";
import { sessionQueryOptions } from "@/lib/session";

const PEOPLE = "People";
const AGENTS = "Agents";

type Person = { ref: string; handle: string; name: string; you: boolean };

/** Persistent, live agents, in the reporting tree's order (the server's). */
const managersInTree = (data: AgentSummary[]) =>
  data
    .filter((a) => a.kind === "persistent" && !a.archivedAt && !a.terminatedAt)
    .map((a) => ({ ref: a.ref, handle: a.handle, displayName: a.displayName }));
const liveRefs = (data: AgentSummary[]) =>
  new Set(data.filter((a) => !a.archivedAt && !a.terminatedAt).map((a) => a.ref));

const NO_AGENTS: { ref: string; handle: string; displayName: string }[] = [];

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

/** A saved manager the pick no longer lists (archived, disabled, or not loaded yet), named by its current handle. */
function GoneManager({ agentRef, note }: { agentRef: string; note?: string }) {
  const handle = usePrincipal(agentRef).principal?.handle;
  return `@${handle ?? "…"}${note ? ` (${note})` : ""}`;
}

/** Reporting-line depth as padding: 0.75rem a level, three levels at most, then a `└ `. */
function AgentRow({ agentRef }: { agentRef: string }) {
  const depth = useAgent(agentRef)?.depth ?? 0;
  return (
    <span
      className="flex min-w-0 items-center gap-1"
      style={{ paddingInlineStart: `${Math.min(depth, 3) * 0.75}rem` }}
    >
      {depth > 3 && <span aria-hidden="true">└</span>}
      <AgentChip agentRef={agentRef} badge showHandle />
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
  /** The chosen manager's ref, an agent's or a human's. */
  onValueChange(ref: string): void;
  /** A stable predicate over an agent's ref. */
  canManage?: (agentRef: string) => boolean;
  id?: string;
  disabled?: boolean;
  "aria-label": string;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}) {
  const agents = useQuery({ ...agentsListQueryOptions("exclude"), select: managersInTree });
  const live = useQuery({ ...agentsListQueryOptions("exclude"), select: liveRefs });
  const users = useQuery(usersQueryOptions);
  const session = useQuery(sessionQueryOptions).data?.user;
  const meHandle = session?.handle;
  const meRef = session?.ref;
  const meName = session?.name;

  const people = useMemo((): Person[] => {
    const others = (users.data ?? [])
      .filter((u) => !u.disabledAt && u.ref !== meRef)
      .map((u) => ({ ref: u.ref, handle: u.handle, name: u.name, you: false }));
    if (!meHandle || !meRef) return others;
    // You come from the session, so the pick works while the users list is loading or has failed.
    const mine = users.data?.find((u) => u.ref === meRef);
    return [
      { ref: meRef, handle: meHandle, name: mine?.name ?? meName ?? "", you: true },
      ...others,
    ];
  }, [users.data, meHandle, meRef, meName]);
  const peopleByRef = useMemo(() => new Map(people.map((p) => [p.ref, p] as const)), [people]);

  const options = useMemo((): ComboOption[] => {
    const manageable = (agents.data ?? NO_AGENTS).filter((a) => !canManage || canManage(a.ref));
    return [
      ...people.map(
        (p): ComboOption => ({
          value: p.ref,
          label: p.you ? `You (${p.name} · @${p.handle})` : p.name,
          keywords: [p.handle],
          group: PEOPLE,
        }),
      ),
      ...manageable.map(
        (a): ComboOption => ({
          value: a.ref,
          label: a.displayName || a.handle,
          keywords: [a.handle],
          group: AGENTS,
        }),
      ),
    ];
  }, [people, agents.data, canManage]);

  const disabledRefs = useMemo(
    () => new Set((users.data ?? []).filter((u) => u.disabledAt).map((u) => u.ref)),
    [users.data],
  );
  const renderOption = useCallback(
    (o: ComboOption): ReactNode => {
      const p = o.group === PEOPLE ? peopleByRef.get(o.value) : undefined;
      return p ? <PersonChip person={p} /> : <AgentRow agentRef={o.value} />;
    },
    [peopleByRef],
  );
  const renderValue = useCallback(
    (v: string): ReactNode => {
      const p = peopleByRef.get(v);
      if (p) return <PersonChip person={p} />;
      if (disabledRefs.has(v)) return <GoneManager agentRef={v} note="disabled" />;
      if (live.data?.has(v) && (!canManage || canManage(v)))
        return <AgentChip agentRef={v} badge showHandle inline />;
      // Archived only once both lists have answered: a loading or failed list says nothing about the manager.
      return <GoneManager agentRef={v} note={live.data && users.data ? "archived" : undefined} />;
    },
    [peopleByRef, disabledRefs, live.data, users.data, canManage],
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
