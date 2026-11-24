import { type RowState as RowStateName, rowStateOf } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import { ErrorLine } from "@/components/error-line";
import { MiddleTruncate } from "@/components/middle-truncate";
import { visibleControls } from "@/components/untrusted-text";
import { FORM_MSG } from "@/lib/form-messages";
import { type MarketplaceRow, marketplacesQueryOptions } from "@/lib/library";
import type { Arrival } from "@/lib/use-arrival";
import { count, marketplaceSourceLabel, usedByText } from "./format";
import { arrivalProps, POPUP, ROW, SKELETON, useRowKeys } from "./list-parts";
import { RowState } from "./row-state";
import { marketplaceKey, type PeekControl } from "./use-peek";

/** A marketplace's one state, by precedence. */
function marketplaceState(m: MarketplaceRow): RowStateName | undefined {
  return rowStateOf([
    ...(m.state === "adding" ? (["adding"] as const) : []),
    ...(m.checking ? (["checking"] as const) : []),
    ...(m.checkError ? (["check_failed"] as const) : []),
    ...(m.updateCommit ? (["update"] as const) : []),
  ]);
}

/** The server's `since` for a pending state, which a row shows as elapsed time after 10 s. */
const pendingSince = (m: MarketplaceRow, state: RowStateName | undefined) =>
  state === "adding"
    ? (m.since ?? undefined)
    : state === "checking"
      ? m.checking?.since
      : undefined;

const MarketplaceItem = memo(function MarketplaceItem({
  m,
  selected,
  arrival,
  onArrivedEnd,
  onOpen,
}: {
  m: MarketplaceRow;
  selected: boolean;
  arrival: Arrival | undefined;
  onArrivedEnd(): void;
  onOpen(key: string): void;
}) {
  const key = marketplaceKey(m.name);
  const state = marketplaceState(m);
  const live = m.source.source === "directory";
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        data-row=""
        data-peek-key={key}
        data-update={state === "update" ? "" : undefined}
        {...POPUP}
        aria-expanded={selected}
        aria-current={selected ? "true" : undefined}
        onClick={() => onOpen(key)}
        className={ROW}
        {...arrivalProps(arrival, onArrivedEnd)}
      >
        <span className="font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
          {visibleControls(m.name)}
        </span>
        <span className="flex min-w-20 flex-auto font-mono text-[0.8125rem] text-muted-foreground">
          <span dir="ltr" className="flex min-w-0 flex-1 [unicode-bidi:isolate]">
            <MiddleTruncate text={visibleControls(marketplaceSourceLabel(m.source))} />
          </span>
        </span>
        <span className="font-mono text-[0.8125rem] text-muted-foreground">
          {live ? "Live" : m.state === "adding" ? "" : (m.commit?.slice(0, 7) ?? "")}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {count(m.plugins.length, "plugin")}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {usedByText(m.usedBy.templates, 0)}
        </span>
        {state && <RowState state={state} since={pendingSince(m, state)} />}
      </button>
    </li>
  );
});

/**
 * The Marketplaces view (spec §10.2): one row per registered marketplace, a button that opens its peek. A pending add
 * (a re-fetch) is its own row with a spinner and the elapsed time from the server's `since`.
 */
export function MarketplaceList({
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
  const q = useQuery(marketplacesQueryOptions);
  const { list, onKeyDown, onKeyUp } = useRowKeys(peek);
  const data = q.data;
  if (!data)
    return q.isError ? (
      <ErrorLine text={FORM_MSG.loadMarketplaces} onRetry={() => void q.refetch()} />
    ) : (
      SKELETON
    );
  if (data.marketplaces.length === 0)
    return (
      <p className="text-sm text-muted-foreground">No marketplaces yet. Add one to pick plugins.</p>
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys are the rows' own (j/k, Space, F6), caught at the list
    <div
      ref={list}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className="@container border-y border-border [overflow-anchor:auto]"
    >
      <ul aria-label="Marketplaces">
        {data.marketplaces.map((m) => {
          const key = marketplaceKey(m.name);
          return (
            <MarketplaceItem
              key={m.name}
              m={m}
              selected={peek.key === key}
              arrival={arrivedKey === key ? arrival : undefined}
              onArrivedEnd={onArrivedEnd}
              onOpen={peek.show}
            />
          );
        })}
      </ul>
    </div>
  );
}
