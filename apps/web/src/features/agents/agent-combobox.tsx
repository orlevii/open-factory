import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo } from "react";
import { AgentChip } from "@/components/agent-chip";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { agentsListQueryOptions } from "@/features/session/api";

/** The only fields the picker reads. Status frames change none of them, so the list isn't rebuilt. */
export type AgentOpt = Pick<AgentSummary, "ref" | "handle" | "displayName" | "kind" | "reportsTo">;

const project = (a: AgentSummary): AgentOpt => ({
  ref: a.ref,
  handle: a.handle,
  displayName: a.displayName,
  kind: a.kind,
  reportsTo: a.reportsTo,
});
const isLive = (a: AgentSummary) => !a.archivedAt && !a.terminatedAt;

// Stable module-level selects: TanStack runs them once per fetched list and keeps the result's
// identity while its content is unchanged (structural sharing), so a status frame costs the picker nothing.
const liveByName = (data: AgentSummary[]): AgentOpt[] =>
  data
    .filter(isLive)
    .map(project)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.handle.localeCompare(b.handle));
const endedAll = (data: AgentSummary[]): AgentOpt[] => data.map(project);

const NONE: AgentOpt[] = [];

const optionOf = (a: AgentOpt, group?: string): ComboOption => ({
  value: a.ref,
  label: a.displayName || a.handle,
  keywords: [a.handle],
  ...(group ? { group } : {}),
});

const renderPlain = (o: ComboOption): ReactNode =>
  o.fixed ? o.label : <AgentChip agentRef={o.value} badge showHandle />;

/**
 * A searchable agent pick (handle or name); its value is the agent's ref. `scope` "live" lists live agents; "live+ended" adds the ended
 * ones in a last "Ended" group (the ended list is fetched only then). A value that isn't listed shows as
 * `@handle` with its face. `filter` must be a stable function (memoize it). Sorted by name.
 */
export function AgentCombobox({
  value,
  onValueChange,
  scope,
  fixed,
  filter,
  placeholder,
  renderValue: renderValueOverride,
  id,
  disabled,
  pending,
  triggerClassName,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  value: string | null;
  /** null is the empty choice (a fixed option whose value is ""). */
  onValueChange(v: string | null): void;
  scope: "live" | "live+ended";
  fixed?: ComboOption[];
  filter?: (a: AgentOpt) => boolean;
  placeholder?: string;
  /** Replaces the closed trigger's content. */
  renderValue?: (value: string) => ReactNode;
  id?: string;
  disabled?: boolean;
  /** A commit is saving: blocks opening but keeps the trigger focusable (see Combobox). */
  pending?: boolean;
  triggerClassName?: string;
  "aria-label": string;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}) {
  const live = useQuery({
    ...agentsListQueryOptions("exclude"),
    select: liveByName,
  });
  const endedList = useQuery({
    ...agentsListQueryOptions("only"),
    enabled: scope === "live+ended",
    select: endedAll,
  });
  const liveAgents = live.data ?? NONE;
  const endedAgents = scope === "live+ended" ? (endedList.data ?? NONE) : NONE;

  const options = useMemo(() => {
    const keep = (a: AgentOpt) => !filter || filter(a);
    return [
      ...(fixed ?? []),
      ...liveAgents.filter(keep).map((a) => optionOf(a)),
      ...endedAgents.filter(keep).map((a) => optionOf(a, "Ended")),
    ];
  }, [fixed, filter, liveAgents, endedAgents]);

  const renderValue = useCallback(
    (v: string): ReactNode => {
      const f = fixed?.find((o) => o.value === v);
      if (f) return f.label;
      // Inline: the trigger keeps the one control height; a narrow trigger truncates rather than stacking.
      return renderValueOverride ? (
        renderValueOverride(v)
      ) : (
        <AgentChip agentRef={v} badge showHandle inline />
      );
    },
    [fixed, renderValueOverride],
  );

  return (
    <Combobox
      value={value ?? ""}
      onValueChange={(v) => onValueChange(v === "" ? null : v)}
      options={options}
      placeholder={placeholder}
      emptyText="No agent matches."
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      id={id}
      disabled={disabled}
      pending={pending}
      triggerClassName={triggerClassName}
      renderOption={renderPlain}
      renderValue={renderValue}
    />
  );
}
