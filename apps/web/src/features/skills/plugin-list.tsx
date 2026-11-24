import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memo, useId } from "react";
import { ErrorLine } from "@/components/error-line";
import { visibleControls } from "@/components/untrusted-text";
import { LatestBadge } from "@/features/config/latest-badge";
import { openSheet } from "@/features/sheets/sheet-store";
import { FORM_MSG } from "@/lib/form-messages";
import { type PluginsResponse, pluginsQueryOptions } from "@/lib/library";
import type { Arrival } from "@/lib/use-arrival";
import { ContentsLine } from "./contents-line";
import { pluginRowState, usedByText, versionLabel } from "./format";
import { arrivalProps, POPUP, ROW, type RowProps, SKELETON, useRowKeys } from "./list-parts";
import { PluginKey } from "./plugin-key";
import { RowState } from "./row-state";
import { hostPluginKey, type PeekControl, pluginKey } from "./use-peek";

type Entry = PluginsResponse["marketplaces"][number]["plugins"][number];
type HostEntry = PluginsResponse["host"][number];

/** Users as the row counts them: templates, the agents on them and the agents that add it, and who runs Latest. */
function usage(u: Entry["usedBy"]) {
  const agents = u.templates.reduce((n, t) => n + t.agents, 0) + u.overlays.length;
  const latest =
    u.templates.filter((t) => t.pin === "latest").length +
    u.overlays.filter((o) => o.pin === "latest").length;
  return { templates: u.templates.length, agents, latest };
}

const PluginRow = memo(function PluginRow({
  entry,
  selected,
  arrival,
  onArrivedEnd,
  onOpen,
}: RowProps & { entry: Entry }) {
  const key = pluginKey(entry.key);
  const u = usage(entry.usedBy);
  const state = pluginRowState(entry);
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
        <span className="min-w-0">
          <PluginKey pluginKey={entry.key} />
        </span>
        {entry.version && (
          <span className="font-mono text-[0.8125rem] text-muted-foreground">
            {versionLabel(entry.version)}
          </span>
        )}
        <span className="min-w-0 flex-auto text-[0.8125rem]">
          <ContentsLine
            summary={entry.contentsSummary}
            unreadable={entry.canRead ? "Contents not read yet" : "Contents not shown"}
          />
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {usedByText(u.templates, u.agents)}
        </span>
        {u.latest > 0 && <LatestBadge />}
        {state && <RowState state={state} />}
      </button>
    </li>
  );
});

const HostRow = memo(function HostRow({
  entry,
  selected,
  arrival,
  onArrivedEnd,
  onOpen,
}: RowProps & { entry: HostEntry }) {
  const key = hostPluginKey(entry.key);
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
        <span className="min-w-0">
          <PluginKey pluginKey={entry.key} />
        </span>
        {entry.version && (
          <span className="font-mono text-[0.8125rem] text-muted-foreground">
            {versionLabel(entry.version)}
          </span>
        )}
        <span className="min-w-0 flex-auto text-[0.8125rem]">
          <ContentsLine
            summary={entry.contentsSummary}
            unreadable={entry.cantShow ?? "Contents not shown"}
          />
        </span>
      </button>
    </li>
  );
});

function GroupHeader({
  labelId,
  name,
  commit,
  adding,
  since,
}: {
  labelId: string;
  name: string;
  /** The commit Skills read; null for a local folder, which is live. */
  commit: string | null;
  adding: boolean;
  /** The server's start of the add, for its elapsed time. */
  since: string | undefined;
}) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-border px-2 py-2 text-sm">
      <span
        id={labelId}
        className="font-mono text-[0.8125rem] font-medium [overflow-wrap:anywhere]"
      >
        {visibleControls(name)}
      </span>
      <span className="text-[0.8125rem] text-muted-foreground">
        {commit ? <span className="font-mono">{commit.slice(0, 7)}</span> : "Local folder, live"}
      </span>
      {adding && <RowState state="adding" since={since} />}
    </div>
  );
}

type GroupProps = {
  shownKey: string | null;
  arrivedKey: string | undefined;
  arrival: Arrival | undefined;
  onArrivedEnd(): void;
  onOpen(key: string): void;
};

const MarketplaceGroup = memo(function MarketplaceGroup({
  m,
  shownKey,
  arrivedKey,
  arrival,
  onArrivedEnd,
  onOpen,
}: GroupProps & { m: PluginsResponse["marketplaces"][number] }) {
  const labelId = useId();
  return (
    <section>
      <GroupHeader
        labelId={labelId}
        name={m.name}
        commit={m.commit}
        adding={m.state === "adding"}
        since={m.since ?? undefined}
      />
      {m.plugins.length > 0 && (
        <ul aria-labelledby={labelId}>
          {m.plugins.map((p) => {
            const key = pluginKey(p.key);
            return (
              <PluginRow
                key={p.key}
                entry={p}
                selected={shownKey === key}
                arrival={arrivedKey === key ? arrival : undefined}
                onArrivedEnd={onArrivedEnd}
                onOpen={onOpen}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
});

const HostGroup = memo(function HostGroup({
  entries,
  shownKey,
  arrivedKey,
  arrival,
  onArrivedEnd,
  onOpen,
}: GroupProps & { entries: HostEntry[] }) {
  const labelId = useId();
  return (
    <section>
      <div className="flex min-h-11 items-center border-b border-border px-2 py-2 text-sm">
        <span id={labelId} className="font-medium">
          On this host
        </span>
      </div>
      <ul aria-labelledby={labelId}>
        {entries.map((p) => {
          const key = hostPluginKey(p.key);
          return (
            <HostRow
              key={p.key}
              entry={p}
              selected={shownKey === key}
              arrival={arrivedKey === key ? arrival : undefined}
              onArrivedEnd={onArrivedEnd}
              onOpen={onOpen}
            />
          );
        })}
      </ul>
    </section>
  );
});

/** Whether the peek's key (or the arrival's) names a row of these keys, so another group's retarget doesn't re-render this one. */
const within = (key: string | null | undefined, keys: string[]) =>
  key != null && keys.includes(key);

/**
 * The Plugins view (spec §10.2): one group per registered marketplace, headed by its name and the commit Skills read
 * ("Local folder, live" for a folder), then "On this host". Rows and keys work as on the Skills view.
 */
export function PluginList({
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
  const q = useQuery(pluginsQueryOptions);
  const { list, onKeyDown, onKeyUp } = useRowKeys(peek);
  const data = q.data;
  if (!data)
    return q.isError ? (
      <ErrorLine text={FORM_MSG.loadPlugins} onRetry={() => void q.refetch()} />
    ) : (
      SKELETON
    );
  if (data.marketplaces.length === 0 && data.host.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No plugins yet. Add a marketplace to pick plugins.{" "}
        <Link
          to="/skills/marketplaces"
          onClick={() => openSheet({ kind: "add-marketplace" }, { at: "/skills/marketplaces" })}
          className="underline underline-offset-2 hover:text-foreground"
        >
          Add a marketplace
        </Link>
      </p>
    );
  const tint = (keys: string[]) => ({
    shownKey: within(peek.key, keys) ? peek.key : null,
    arrivedKey: within(arrivedKey, keys) ? arrivedKey : undefined,
    arrival: within(arrivedKey, keys) ? arrival : undefined,
    onArrivedEnd,
    onOpen: peek.show,
  });
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys are the rows' own (j/k, Space, F6), caught at the list
    <div
      ref={list}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className="@container border-y border-border [overflow-anchor:auto]"
    >
      {data.marketplaces.map((m) => (
        <MarketplaceGroup key={m.name} m={m} {...tint(m.plugins.map((p) => pluginKey(p.key)))} />
      ))}
      {data.host.length > 0 && (
        <HostGroup entries={data.host} {...tint(data.host.map((p) => hostPluginKey(p.key)))} />
      )}
    </div>
  );
}
