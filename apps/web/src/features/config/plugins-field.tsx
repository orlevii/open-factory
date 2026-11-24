import { pinOf } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import type { ComboOption } from "@/components/ui/combobox";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { UntrustedProse, visibleControls } from "@/components/untrusted-text";
import { ContentsLine } from "@/features/skills/contents-line";
import { contentKinds, pluginRowState, versionLabel } from "@/features/skills/format";
import { PluginKey } from "@/features/skills/plugin-key";
import { RowState } from "@/features/skills/row-state";
import { IssueIcon } from "@/features/templates/issue-list";
import {
  type MarketplacesResponse,
  marketplacesQueryOptions,
  pluginQueryOptions,
} from "@/lib/library";
import type { AddSlot, RowNote } from "./config-list";
import { FIELD_PATHS, MARKETPLACES_PATH } from "./fields";
import { CONFIG_COPY, PLUGIN_COPY } from "./messages";
import { PickAddMany, pickEmpty } from "./pick-add";
import { PinControl, pinRefFor } from "./plugin-pin";
import { type ConfigScope, useConfigScope, useFieldNote } from "./scope";
import { WrongType } from "./section";
import { isRec, readAt } from "./tolerant";

type Row = MarketplacesResponse["marketplaces"][number];
type Entry = Row["plugins"][number];
type Rec = Record<string, unknown>;

const NO_KEYS: readonly string[] = [];
const NO_REC: Rec = {};
const NO_NOTES: ReadonlyMap<string, RowNote> = new Map();
const NO_ENTRIES: ReadonlyMap<string, Entry> = new Map();
const NO_ROWS: ReadonlyMap<string, Row> = new Map();
const NO_OPTIONS: ComboOption[] = [];

/** The peek is the biggest thing the form can open: it loads when View is first used. */
const PluginPeekBody = lazy(() =>
  import("@/features/skills/peeks/plugin-peek").then((m) => ({ default: m.PluginPeekBody })),
);

/** The Library list of marketplaces is in the cache from the route's prefetch (R-B1); an empty cache fetches once. */
const pickerQuery = { ...marketplacesQueryOptions, refetchOnMount: false } as const;

const marketplaceOf = (key: string) => key.slice(key.lastIndexOf("@") + 1);

/** Keys grouped by marketplace, in the order each marketplace first appears. */
function groupByMarketplace(keys: readonly string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const k of keys) {
    const m = marketplaceOf(k);
    const g = groups.get(m);
    if (g) g.push(k);
    else groups.set(m, [k]);
  }
  return [...groups];
}

/** `settings.enabledPlugins` and `settings.extraKnownMarketplaces` as the draft holds them, tolerantly. */
const recAt = (root: unknown, path: readonly string[]): Rec | undefined => {
  const r = readAt(root, path);
  return r.ok && isRec(r.value) ? r.value : undefined;
};

/** The declaration a first pick writes for an undeclared marketplace: pinned by default; a folder is live. */
function declarationFor(row: Row): Rec {
  if (row.source.source === "directory") return { source: row.source };
  return { source: { ...row.source, ref: pinRefFor(row) } };
}

/** Why a pick can't join the marketplace's declaration (or the one a template pick would write), or undefined. */
function refusalFor(key: string, entry: Entry | undefined, row: Row | undefined, decl: unknown) {
  const mkt = marketplaceOf(key);
  const cantPin = !!entry && (!entry.pinnable || entry.state === "cant_pin");
  if (decl !== undefined) {
    const kind = pinOf(decl).kind;
    return cantPin && (kind === "commit" || kind === "tag")
      ? PLUGIN_COPY.cantPin(key, mkt)
      : undefined;
  }
  if (!row || row.source.source === "directory") return undefined;
  if (cantPin) return PLUGIN_COPY.cantPinFirst(key, mkt);
  if (pinRefFor(row) === undefined)
    return row.commit === null ? PLUGIN_COPY.notRead(mkt) : PLUGIN_COPY.tagOnly(mkt);
  return undefined;
}

/** The settings with the plugin enabled and, for a marketplace the settings don't declare yet, its declaration. */
function withPlugin(settings: unknown, key: string, mkt: string, decl: Rec | undefined): Rec {
  const s = isRec(settings) ? settings : {};
  const out: Rec = {
    ...s,
    enabledPlugins: { ...(isRec(s.enabledPlugins) ? s.enabledPlugins : {}), [key]: true },
  };
  if (decl) {
    const declared = isRec(s.extraKnownMarketplaces) ? s.extraKnownMarketplaces : {};
    if (!Object.hasOwn(declared, mkt)) out.extraKnownMarketplaces = { ...declared, [mkt]: decl };
  }
  return out;
}

/** The declarations with one marketplace's `source.ref` set, or removed for Latest. Every other key stays. */
function withRef(prev: unknown, mkt: string, ref: string | undefined): Rec {
  const all = isRec(prev) ? prev : {};
  const decl = isRec(all[mkt]) ? all[mkt] : {};
  const { ref: _was, ...source } = isRec(decl.source) ? decl.source : ({} as Rec);
  return { ...all, [mkt]: { ...decl, source: ref === undefined ? source : { ...source, ref } } };
}

const without = (prev: unknown, key: string): Rec =>
  Object.fromEntries(Object.entries(isRec(prev) ? prev : {}).filter(([k]) => k !== key));

/** A plugin's version at the pin, read from its contents at that commit (the Library's list holds the newest one). */
function PinnedVersion({ pluginKey, commit }: { pluginKey: string; commit: string }) {
  const q = useQuery(pluginQueryOptions(pluginKey, "library", commit));
  return q.data?.version ? (
    <span className="text-muted-foreground">{versionLabel(q.data.version)}</span>
  ) : null;
}

const PluginRow = memo(function PluginRow({
  pluginKey,
  entry,
  pinCommit,
  libraryCommit,
  running,
  note,
  onRemove,
  onView,
}: {
  pluginKey: string;
  entry: Entry | undefined;
  /** The commit the template's pin resolves to; absent for Latest and for a folder. */
  pinCommit: string | undefined;
  libraryCommit: string | null | undefined;
  running: string | undefined;
  note: RowNote | undefined;
  /** Absent on read-only rows. */
  onRemove: ((key: string) => void) | undefined;
  onView: (key: string, commit: string | undefined) => void;
}) {
  const atPin = pinCommit !== undefined && !!libraryCommit && pinCommit !== libraryCommit;
  const state = entry ? pluginRowState(entry) : "missing";
  const needs = entry?.contentsSummary?.needs ?? 0;
  return (
    <li
      data-plugin={pluginKey}
      className="flex min-h-8 items-start gap-2 rounded-md px-2 pointer-coarse:min-h-10"
    >
      <div className="grid min-w-0 flex-1 gap-0.5 py-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <PluginKey pluginKey={pluginKey} />
          {atPin && pinCommit ? (
            <PinnedVersion pluginKey={pluginKey} commit={pinCommit} />
          ) : entry?.version ? (
            <span className="text-[0.8125rem] text-muted-foreground">
              {versionLabel(entry.version)}
            </span>
          ) : null}
          {running ? (
            <span className="text-[0.8125rem] text-muted-foreground">
              {PLUGIN_COPY.running(running)}
            </span>
          ) : null}
          {state ? <RowState state={state} /> : null}
        </div>
        {entry ? (
          <div className="flex flex-wrap gap-x-3 text-[0.8125rem]">
            <ContentsLine summary={entry.contentsSummary} unreadable={CONFIG_COPY.notReadYet} />
            {needs > 0 ? (
              <span className="text-muted-foreground">{PLUGIN_COPY.needs(needs)}</span>
            ) : null}
          </div>
        ) : null}
        {note ? (
          <p
            className={`flex items-start gap-1.5 pb-1 text-[0.8125rem] ${note.severity === "error" ? "text-destructive" : "text-foreground"}`}
          >
            <IssueIcon severity={note.severity} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{note.message}</span>
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-0.5"
        aria-label={`${CONFIG_COPY.view} ${pluginKey}`}
        onClick={() => onView(pluginKey, pinCommit)}
      >
        {CONFIG_COPY.view}
      </Button>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-0.5"
          aria-label={PLUGIN_COPY.remove(pluginKey)}
          onClick={() => onRemove(pluginKey)}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
});

/** The pin a declaration resolves to as a commit: its commit, or the commit its tag was recorded at. */
function commitOf(decl: unknown, row: Row | undefined): string | undefined {
  const pin = pinOf(decl);
  return pin.kind === "commit"
    ? pin.sha
    : pin.kind === "tag" && row && Object.hasOwn(row.tags, pin.name)
      ? row.tags[pin.name]
      : undefined;
}

/** One marketplace's plugins, headed by its name and its pin (spec §10.5). */
const PluginGroup = memo(function PluginGroup({
  mkt,
  keys,
  decl,
  row,
  entries,
  editPin,
  running,
  notes,
  mktNote,
  onPin,
  onRemove,
  onView,
}: {
  mkt: string;
  keys: readonly string[];
  /** The marketplace's declaration, absent when the settings don't declare it (the server says so on the row). */
  decl: unknown;
  row: Row | undefined;
  entries: ReadonlyMap<string, Entry>;
  editPin: boolean;
  running: ReadonlyMap<string, string>;
  notes: ReadonlyMap<string, RowNote>;
  mktNote: RowNote | undefined;
  onPin: (mkt: string, ref: string | undefined) => void;
  onRemove: ((key: string) => void) | undefined;
  onView: (key: string, commit: string | undefined) => void;
}) {
  const labelId = `plugins-${mkt}`;
  const pinCommit = decl === undefined ? undefined : commitOf(decl, row);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group named by its marketplace, with its own list inside
    <div role="group" aria-labelledby={labelId} className="grid gap-1">
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem]">
        <span id={labelId} className="min-w-0 font-mono font-medium">
          <MiddleTruncate text={mkt} />
        </span>
        {decl !== undefined ? (
          <PinControl
            marketplace={mkt}
            decl={decl}
            row={row}
            keys={keys}
            editable={editPin}
            onPin={onPin}
          />
        ) : null}
      </div>
      {mktNote ? (
        <p
          className={`flex items-start gap-1.5 text-[0.8125rem] ${mktNote.severity === "error" ? "text-destructive" : "text-foreground"}`}
        >
          <IssueIcon severity={mktNote.severity} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{mktNote.message}</span>
        </p>
      ) : null}
      <ul className="grid">
        {keys.map((k) => (
          <PluginRow
            key={k}
            pluginKey={k}
            entry={entries.get(k)}
            pinCommit={pinCommit}
            libraryCommit={row?.commit}
            running={running.get(k)}
            note={notes.get(k)}
            onRemove={onRemove}
            onView={onView}
          />
        ))}
      </ul>
    </div>
  );
});

/** Two lines (spec §10.5): the name (mono, wraps), then the version and contents, muted, one line. */
const renderPlugin = (o: ComboOption) => (
  <span className="grid min-w-0">
    <span className="font-mono text-[0.8125rem] whitespace-normal [overflow-wrap:anywhere]">
      {visibleControls(o.label)}
    </span>
    {o.keywords?.[0] ? (
      <span className="truncate text-xs text-muted-foreground">
        <UntrustedProse text={o.keywords[0]} />
      </span>
    ) : null}
  </span>
);

const renderGroup = (group: string) => <MiddleTruncate text={group} />;

/**
 * The plugins a start can use: those of registered marketplaces (agent mode: of the template's declared ones) whose
 * source isn't refused. `leftOut` counts what the refused-source rule hides.
 */
function pickable(data: MarketplacesResponse | undefined, allowed: Rec | undefined) {
  const options: ComboOption[] = [];
  let leftOut = 0;
  for (const m of data?.marketplaces ?? []) {
    if (allowed && !Object.hasOwn(allowed, m.name)) continue;
    for (const p of m.plugins) {
      if (p.state === "refused" || p.state === "missing") {
        leftOut++;
        continue;
      }
      const line = [
        p.version ? versionLabel(p.version) : "",
        p.contentsSummary ? contentKinds(p.contentsSummary).slice(0, 3).join(", ") : "",
        !p.pinnable || p.state === "cant_pin" ? PLUGIN_COPY.cantPinOption : "",
      ]
        .filter(Boolean)
        .join(" · ");
      options.push({ value: p.key, label: p.key, keywords: [line], group: m.name });
    }
  }
  return { options, leftOut };
}

function PluginPicker({
  slot,
  data,
  isPending,
  isError,
  agentDecls,
  template,
  picked,
  onPick,
}: {
  slot: AddSlot;
  data: MarketplacesResponse | undefined;
  isPending: boolean;
  isError: boolean;
  /** Agent mode: the template's declarations, whose marketplaces are the only ones offered. */
  agentDecls: Rec | undefined;
  template: string | undefined;
  picked: readonly string[];
  onPick: (key: string) => string | undefined;
}) {
  const { options, leftOut } = useMemo(() => pickable(data, agentDecls), [data, agentDecls]);
  const emptyText =
    isError || isPending
      ? pickEmpty({ isPending, isError }, "")
      : options.length > 0
        ? CONFIG_COPY.allPluginsAdded
        : leftOut === 0
          ? agentDecls
            ? PLUGIN_COPY.noPlugins(template ?? PLUGIN_COPY.theTemplate)
            : PLUGIN_COPY.noPluginsInSkills
          : "";
  return (
    <PickAddMany
      slot={slot}
      label={CONFIG_COPY.addPlugin}
      options={isError || isPending ? NO_OPTIONS : options}
      emptyText={emptyText}
      renderOption={renderPlugin}
      renderGroup={renderGroup}
      picked={picked}
      onPick={onPick}
      footer={
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {leftOut > 0 ? <p>{PLUGIN_COPY.leftOut(leftOut)}</p> : null}
          <p>
            {agentDecls
              ? PLUGIN_COPY.onlyFrom(template ?? PLUGIN_COPY.theTemplate)
              : CONFIG_COPY.addMarketplacesInSkills}
          </p>
        </div>
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
          {CONFIG_COPY.addPlugin}
        </Button>
      }
    />
  );
}

type View = { key: string; commit: string | undefined };
const noop = () => {};

/** The read-only plugin peek at a template's pin: the Configuration form's View. */
function PluginView({
  view,
  open,
  onOpenChange,
}: {
  view: View | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!view) return null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined}>
        <Suspense fallback={null}>
          <PluginPeekBody
            key={`${view.key}\0${view.commit ?? ""}`}
            pluginKey={view.key}
            commit={view.commit}
            readOnly
            back={null}
            onBack={noop}
          />
        </Suspense>
      </SheetContent>
    </Sheet>
  );
}

/** A marketplace-level issue (`settings.extraKnownMarketplaces.acme…`, an item with no `@`) lands on the group it names. */
function noteFor(items: ConfigScope["byField"], mkt: string): RowNote | undefined {
  for (const [item, note] of items.get("plugins")?.items ?? [])
    if (item === mkt || item.startsWith(`${mkt}.`)) return note;
  return undefined;
}

/**
 * The Plugins field of the Configuration form (spec §10.5, §7.4): `settings.enabledPlugins` as rows grouped by
 * marketplace, each group with its pin. Template mode picks plugins (a first pick from a new marketplace declares it,
 * pinned to the Library's commit), changes pins through reviews and removes rows; agent mode shows the template's
 * plugins and pins read-only, and picks into the overlay's `enabledPlugins`, which run at the template's pin.
 */
export function PluginsField() {
  const s = useConfigScope();
  const { update, value, base, mode, readOnly, byField, running } = s;
  const q = useQuery(pickerQuery);
  const agent = mode === "agent";
  const note = useFieldNote("plugins");
  const [view, setView] = useState<View | null>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const ownRead = readAt(value, FIELD_PATHS.plugins);
  const own = ownRead.ok && isRec(ownRead.value) ? ownRead.value : undefined;
  const wrongType = !ownRead.ok || (ownRead.value !== undefined && !isRec(ownRead.value));
  const tpl = agent && base ? recAt(base, FIELD_PATHS.plugins) : undefined;
  const decls = recAt(agent ? base : value, MARKETPLACES_PATH) ?? NO_REC;

  const ownKeys = useMemo(() => (own ? Object.keys(own) : NO_KEYS), [own]);
  const tplKeys = useMemo(() => (tpl ? Object.keys(tpl) : NO_KEYS), [tpl]);
  const ownGroups = useMemo(() => groupByMarketplace(ownKeys), [ownKeys]);
  const tplGroups = useMemo(() => groupByMarketplace(tplKeys), [tplKeys]);
  const rows = useMemo(
    () => (q.data ? new Map(q.data.marketplaces.map((m) => [m.name, m])) : NO_ROWS),
    [q.data],
  );
  const entries = useMemo(
    () =>
      q.data
        ? new Map(q.data.marketplaces.flatMap((m) => m.plugins.map((p) => [p.key, p] as const)))
        : NO_ENTRIES,
    [q.data],
  );
  const notes = useMemo(() => {
    const m = new Map<string, RowNote>();
    for (const [item, n] of byField.get("plugins")?.items ?? []) m.set(item, n);
    return m.size === 0 ? NO_NOTES : m;
  }, [byField]);
  const picked = useMemo(() => [...ownKeys, ...tplKeys], [ownKeys, tplKeys]);

  const onRemove = useCallback(
    (key: string) => update(FIELD_PATHS.plugins, (prev) => without(prev, key)),
    [update],
  );
  const onPin = useCallback(
    (mkt: string, ref: string | undefined) =>
      update(MARKETPLACES_PATH, (prev) => withRef(prev, mkt, ref)),
    [update],
  );
  const onView = useCallback((key: string, commit: string | undefined) => {
    setView({ key, commit });
    setViewOpen(true);
  }, []);

  // A refused pick stops before the draft changes; a pick that passes is written by `add`.
  const onPick = (key: string) => {
    const mkt = marketplaceOf(key);
    return refusalFor(key, entries.get(key), rows.get(mkt), decls[mkt]);
  };
  const add = (key: string) => {
    const mkt = marketplaceOf(key);
    const row = rows.get(mkt);
    const decl = agent || !row || Object.hasOwn(decls, mkt) ? undefined : declarationFor(row);
    update(["settings"], (prev) => withPlugin(prev, key, mkt, decl));
  };
  const reveal = (key: string) =>
    [...(root.current?.querySelectorAll<HTMLElement>("[data-plugin]") ?? [])]
      .find((el) => el.dataset.plugin === key)
      ?.scrollIntoView({ block: "nearest" });

  if (wrongType) return <WrongType field="plugins" label="Plugins" />;

  const editable = !readOnly;
  const groups = (list: [string, string[]][], opts: { editPin: boolean; removable: boolean }) =>
    list.map(([mkt, keys]) => (
      <PluginGroup
        key={mkt}
        mkt={mkt}
        keys={keys}
        decl={decls[mkt]}
        row={rows.get(mkt)}
        entries={entries}
        editPin={opts.editPin && editable}
        running={running}
        notes={notes}
        mktNote={noteFor(byField, mkt)}
        onPin={onPin}
        onRemove={opts.removable && editable ? onRemove : undefined}
        onView={onView}
      />
    ));
  const picker = (wiring: Omit<AddSlot, "add" | "reveal">) => (
    <PluginPicker
      slot={{ ...wiring, add, reveal }}
      data={q.data}
      isPending={q.isPending}
      isError={q.isError}
      agentDecls={agent ? decls : undefined}
      template={s.templateName}
      picked={picked}
      onPick={onPick}
    />
  );

  return (
    <FieldShell
      name="plugins"
      label="Plugins"
      legend
      error={note.error}
      warning={note.warning}
      legendAction={editable && !agent ? picker : undefined}
    >
      {(slot) => (
        <div ref={root} className="grid gap-3">
          {agent && tplKeys.length > 0 ? (
            <div className="grid gap-2">
              <p className="text-[0.8125rem] text-muted-foreground">
                {s.inheritedLabel} · {tplKeys.length}
              </p>
              {groups(tplGroups, { editPin: false, removable: false })}
            </div>
          ) : null}
          {agent ? (
            <div className="grid gap-2">
              <div className="flex min-h-7 items-center justify-between gap-2">
                <p className="text-[0.8125rem] text-muted-foreground">
                  {CONFIG_COPY.thisAgent} · {ownKeys.length}
                </p>
                {editable ? picker(slot) : null}
              </div>
              {groups(ownGroups, { editPin: false, removable: true })}
            </div>
          ) : (
            groups(ownGroups, { editPin: true, removable: true })
          )}
          <PluginView view={view} open={viewOpen} onOpenChange={setViewOpen} />
        </div>
      )}
    </FieldShell>
  );
}
