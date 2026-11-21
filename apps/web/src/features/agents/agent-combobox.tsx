import type { AgentSummary } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo } from "react";
import { AgentChip } from "@/components/agent-chip";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { useAgent } from "@/features/agents/use-agent-index";
import { agentsListQueryOptions } from "@/features/session/api";

/** The only fields the picker reads. Status frames change none of them, so the list isn't rebuilt. */
export type AgentOpt = Pick<AgentSummary, "slug" | "displayName" | "kind" | "reportsTo" | "depth">;

const project = (a: AgentSummary): AgentOpt => ({
  slug: a.slug,
  displayName: a.displayName,
  kind: a.kind,
  reportsTo: a.reportsTo,
  depth: a.depth,
});
const isLive = (a: AgentSummary) => !a.archivedAt && !a.terminatedAt;

// Stable module-level selects: TanStack runs them once per fetched list and keeps the result's
// identity while its content is unchanged (structural sharing), so a status frame costs the picker nothing.
const liveByName = (data: AgentSummary[]): AgentOpt[] =>
  data
    .filter(isLive)
    .map(project)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.slug.localeCompare(b.slug));
/** The server's order is the reporting tree's. */
const liveInTree = (data: AgentSummary[]): AgentOpt[] => data.filter(isLive).map(project);
const endedAll = (data: AgentSummary[]): AgentOpt[] => data.map(project);

const NONE: AgentOpt[] = [];

const optionOf = (a: AgentOpt, group?: string): ComboOption => ({
  value: a.slug,
  label: a.displayName || a.slug,
  keywords: [a.slug],
  ...(group ? { group } : {}),
});

/** Reporting-line depth as padding: 0.75rem a level, three levels at most, then a `└ `. */
function AgentRow({ slug, indent }: { slug: string; indent: boolean }) {
  const depth = useAgent(slug)?.depth ?? 0;
  const level = indent ? Math.min(depth, 3) : 0;
  return (
    <span
      className="flex min-w-0 items-center gap-1"
      style={{ paddingInlineStart: `${level * 0.75}rem` }}
    >
      {indent && depth > 3 && <span aria-hidden="true">└</span>}
      <AgentChip slug={slug} badge showSlug />
    </span>
  );
}
// One renderer per variant, defined once: Combobox takes a single `renderOption`, not a closure per option.
const renderPlain = (o: ComboOption): ReactNode =>
  o.fixed ? o.label : <AgentRow slug={o.value} indent={false} />;
const renderIndented = (o: ComboOption): ReactNode =>
  o.fixed ? o.label : <AgentRow slug={o.value} indent />;

/**
 * A searchable agent pick (slug or name). `scope` "live" lists live agents; "live+ended" adds the ended
 * ones in a last "Ended" group (the ended list is fetched only then). A value that isn't listed shows as
 * `@slug` with its face. `filter` must be a stable function (memoize it). `order` "tree" keeps the
 * reporting tree's order and indents by depth; the default sorts by name.
 */
export function AgentCombobox({
  value,
  onValueChange,
  scope,
  fixed,
  filter,
  order = "name",
  placeholder,
  renderValue: renderValueOverride,
  id,
  disabled,
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
  order?: "name" | "tree";
  placeholder?: string;
  /** Replaces the closed trigger's content. */
  renderValue?: (value: string) => ReactNode;
  id?: string;
  disabled?: boolean;
  triggerClassName?: string;
  "aria-label": string;
  "aria-invalid"?: boolean | undefined;
  "aria-describedby"?: string | undefined;
}) {
  const live = useQuery({
    ...agentsListQueryOptions("exclude"),
    select: order === "tree" ? liveInTree : liveByName,
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
      return renderValueOverride ? renderValueOverride(v) : <AgentChip slug={v} badge showSlug />;
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
      triggerClassName={triggerClassName}
      renderOption={order === "tree" ? renderIndented : renderPlain}
      renderValue={renderValue}
    />
  );
}
