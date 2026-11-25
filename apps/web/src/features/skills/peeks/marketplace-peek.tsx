import { ApiError, type marketplaceUpdateViewSchema } from "@open-factory/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { z } from "zod";
import { ErrorLine } from "@/components/error-line";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import { SheetBody, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { UntrustedInlineCode, UntrustedProse, visibleControls } from "@/components/untrusted-text";
import { LatestBadge } from "@/features/config/latest-badge";
import { TimeAgo } from "@/features/settings/shared";
import { FORM_MSG } from "@/lib/form-messages";
import {
  checkMarketplace,
  fetchMarketplaceRef,
  type MarketplaceRow,
  marketplaceQueryOptions,
  marketplacesQueryOptions,
  pluginQueryOptions,
  removeMarketplace,
  restoreMarketplace,
  selectMarketplaceRow,
  updateMarketplace,
} from "@/lib/library";
import { count, marketplaceSourceLabel, parsePluginPin, versionLabel } from "../format";
import { LINK, neighbourKey, useLatest } from "../helpers";
import { RowState } from "../row-state";
import { pluginKey } from "../use-peek";
import {
  BackButton,
  failure,
  type Line,
  Outcome,
  Pending,
  PinButton,
  Section,
  SkeletonRows,
} from "./sections";

type View = z.infer<typeof marketplaceUpdateViewSchema>;
type Changed = View["changed"][number];

const KIND = { github: "GitHub", git: "Git URL", directory: "Folder" } as const;
const WHAT = { version: "version", source: "source", tree: "files" } as const;

/** Plugins that run code differently first, whatever order the server sent (a stable sort). */
const byRunsCode = (changed: Changed[]) =>
  [...changed].sort((a, b) => Number(b.runsCodeChanged) - Number(a.runsCodeChanged));

function NameList({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="text-[0.8125rem]">
      <p className="text-muted-foreground">{title}</p>
      <ul className="font-mono">
        {names.map((n) => (
          <li key={n}>
            <UntrustedProse text={n} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The plugins an update would change, "Runs code changed" first (spec §7.1, §10.3). `view` undefined is still building. */
function UpdateChanges({ view, loading }: { view: View | null | undefined; loading: boolean }) {
  if (loading)
    return (
      <div role="status">
        <p className="mb-2 text-[0.8125rem] text-muted-foreground">Preparing update…</p>
        <SkeletonRows n={3} />
      </div>
    );
  if (!view)
    return <p className="text-[0.8125rem] text-muted-foreground">Can't show what changes.</p>;
  return (
    <div className="space-y-3">
      {view.changed.length > 0 && (
        <ul className="space-y-1.5">
          {byRunsCode(view.changed).map((c) => (
            <li key={c.name} className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
              <span className="font-mono">
                <UntrustedProse text={c.name} />
              </span>
              {c.runsCodeChanged && <span className="font-medium">Runs code changed</span>}
              <span className="text-muted-foreground">
                {c.what.map((w) => WHAT[w]).join(", ")} changed
              </span>
            </li>
          ))}
        </ul>
      )}
      <NameList title="Removed" names={view.removed} />
      <NameList title="New in this commit" names={view.added} />
    </div>
  );
}

/** A template's pin as a line: its commit (with "older" when it isn't the Library's), tag, Latest or live. */
function PinnedBy({ pin, libraryCommit }: { pin: string; libraryCommit: string | null }) {
  const p = parsePluginPin(pin);
  switch (p.kind) {
    case "commit":
      return (
        <span className="flex items-center gap-1.5">
          <span className="font-mono">{p.sha.slice(0, 7)}</span>
          {p.sha !== libraryCommit && <span className="text-muted-foreground">older</span>}
        </span>
      );
    case "tag":
      return <span className="text-muted-foreground">tag {visibleControls(p.name)}</span>;
    case "latest":
      return <LatestBadge />;
    case "live":
      return <span className="text-muted-foreground">live</span>;
  }
}

/** "Skills hasn't read a1b2c3d" for a hand-written pin with no checkout, with Fetch (spec §7.1). Found by reading one
 *  plugin at that commit: the server refuses it when no checkout exists, and the query refetches after Fetch. */
function UnreadPin({
  name,
  pinRef,
  isTag,
  pluginName,
}: {
  name: string;
  pinRef: string;
  isTag: boolean;
  pluginName: string;
}) {
  const qc = useQueryClient();
  const probe = useQuery({ ...pluginQueryOptions(pluginName, "library", pinRef), retry: false });
  const [line, setLine] = useState<Line>();
  const fetchPin = useMutation({
    mutationFn: () => fetchMarketplaceRef(name, pinRef),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["library"] }),
  });
  // A commit reads as its short form; a tag is a name and shows whole.
  const shown = isTag ? visibleControls(pinRef) : pinRef.slice(0, 7);
  const onFetch = () => {
    setLine(undefined);
    fetchPin.mutate(undefined, {
      onSuccess: () => setLine({ tone: "success", node: `Read ${name} at ${shown}.` }),
      onError: (e) => setLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
    });
  };
  // Only the server's "not read" answer means unread; a network failure or a 500 says nothing about the checkout.
  const unread = probe.error instanceof ApiError && probe.error.code === "not_read";
  if (!unread && !line) return null;
  return (
    <div className="space-y-1">
      {unread && (
        <p className="flex flex-wrap items-center gap-x-2 text-[0.8125rem]">
          <RowState state="missing" />
          <span>
            Skills hasn't read {visibleControls(name)} at {shown}.
          </span>
          <Button
            variant="ghost"
            size="xs"
            aria-disabled={fetchPin.isPending}
            onClick={() => !fetchPin.isPending && onFetch()}
          >
            {fetchPin.isPending ? (
              <Pending label="Fetching…" since={fetchPin.submittedAt} />
            ) : (
              "Fetch"
            )}
          </Button>
        </p>
      )}
      <Outcome line={line} />
    </div>
  );
}

type Pinned = { template: string; pin: string; plugin: string };

/** Each template with the pin it holds this marketplace at (one per template, spec §7.4), from its plugins' users. */
function pinnedBy(plugins: MarketplaceRow["plugins"]): Pinned[] {
  const out = new Map<string, Pinned>();
  for (const p of plugins)
    for (const t of p.usedBy.templates)
      if (!out.has(t.name)) out.set(t.name, { template: t.name, pin: t.pin, plugin: p.key });
  return [...out.values()];
}

/**
 * The Marketplace peek (spec §10.3). The row comes from the cached list at once; the detail query refines it and holds
 * the update view (its GET can be slow, so that section has its own loading state). Check, Update, Fetch and Remove are
 * mutations started from handlers; this body is keyed by the peek's key, so every result is dropped on retarget (R-Q1).
 */
export function MarketplacePeekBody({
  name,
  back,
  onBack,
  onOpen,
  onRemoved,
}: {
  name: string;
  back: string | null;
  onBack(): void;
  onOpen(key: string): void;
  /** The marketplace was removed: close the peek and put focus on `nextKey`'s row. */
  onRemoved(nextKey: string | null): void;
}) {
  const qc = useQueryClient();
  const { data: row } = useQuery({
    ...marketplacesQueryOptions,
    select: selectMarketplaceRow(name),
  });
  const q = useQuery(marketplaceQueryOptions(name));
  const d = q.data;
  const reasonId = useId();
  const [checkLine, setCheckLine] = useState<Line>();
  const [updateLine, setUpdateLine] = useState<Line>();
  const [removeLine, setRemoveLine] = useState<Line>();
  const refresh = () => qc.invalidateQueries({ queryKey: ["library"] });
  const check = useMutation({ mutationFn: () => checkMarketplace(name), onSuccess: refresh });
  const update = useMutation({
    mutationFn: (commit: string) => updateMarketplace(name, commit),
    onSuccess: refresh,
  });
  // The Undo toast comes from the mutation's own `onSuccess`, which still runs if the peek retargets mid-request.
  const remove = useMutation({
    mutationFn: () => removeMarketplace(name),
    onSuccess: async ({ undoUntil }) => {
      const durationMs = Math.max(0, Date.parse(undoUntil) - Date.now());
      notify({
        text: `Removed ${name}.`,
        durationMs,
        undo: async () => {
          await undoRemove.current(undefined);
        },
      });
      await refresh();
    },
  });
  const restore = useMutation({ mutationFn: () => restoreMarketplace(name), onSuccess: refresh });
  const undoRemove = useLatest(restore.mutateAsync);

  const m = d ?? row;
  const commit = m?.commit ?? null;
  // The list row knows the commit while the detail (and its update view) is still building.
  const updateCommit = d?.updateCommit ?? row?.updateCommit ?? null;
  const plugins = row?.plugins ?? [];
  const pinned = pinnedBy(plugins);
  // Hand-written pins to probe, by `commit:<sha>` or `tag:<name>` (Fetch takes either, spec §7.1).
  const unread = new Map<string, { ref: string; isTag: boolean; plugin: string }>();
  for (const p of pinned) {
    const pin = parsePluginPin(p.pin);
    if (pin.kind === "commit" && pin.sha !== commit && !unread.has(p.pin))
      unread.set(p.pin, { ref: pin.sha, isTag: false, plugin: p.plugin });
    else if (pin.kind === "tag" && !unread.has(p.pin))
      unread.set(p.pin, { ref: pin.name, isTag: true, plugin: p.plugin });
  }
  const users = d ? d.usedBy.templates + d.usedBy.agents : 0;
  const inUse = users > 0;
  const live = m?.source.source === "directory";
  const sourceText = m ? marketplaceSourceLabel(m.source) : "";

  const onCheck = () => {
    setCheckLine(undefined);
    check.mutate(undefined, {
      onSuccess: (r) =>
        setCheckLine(
          r.updateCommit || r.checkError ? undefined : { tone: "success", node: "Up to date." },
        ),
      onError: (e) => setCheckLine({ tone: "error", node: failure(e, FORM_MSG.checkFailed) }),
    });
  };
  const onUpdate = () => {
    if (updateCommit === null) return;
    setUpdateLine(undefined);
    update.mutate(updateCommit, {
      onSuccess: () =>
        setUpdateLine({ tone: "success", node: `Updated to ${updateCommit.slice(0, 7)}.` }),
      onError: (e) => setUpdateLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
    });
  };
  const onRemove = () => {
    if (!d || inUse || remove.isPending) return;
    setRemoveLine(undefined);
    const next = neighbourKey("marketplace:", `marketplace:${name}`);
    remove.mutate(undefined, {
      onSuccess: () => onRemoved(next),
      onError: (e) => setRemoveLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
    });
  };

  return (
    <>
      <SheetHeader className="items-center">
        {back !== null && <BackButton onBack={onBack} />}
        <SheetTitle className="font-mono text-sm font-normal">
          <MiddleTruncate text={visibleControls(name)} />
        </SheetTitle>
      </SheetHeader>
      <SheetBody className="space-y-4">
        {!d && q.isError && (
          <ErrorLine text="Couldn't load the marketplace." onRetry={() => void q.refetch()} />
        )}
        <Section
          title="Source"
          action={
            live ? undefined : (
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={check.isPending}
                onClick={() => !check.isPending && onCheck()}
              >
                {check.isPending ? (
                  <Pending label="Checking…" since={check.submittedAt} />
                ) : (
                  "Check for updates"
                )}
              </Button>
            )
          }
        >
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8125rem]">
            <dt className="text-muted-foreground">Kind</dt>
            <dd>{m ? KIND[m.source.source] : ""}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd>
              <UntrustedInlineCode text={sourceText} />
            </dd>
            {m?.branch && (
              <>
                <dt className="text-muted-foreground">Branch</dt>
                <dd className="font-mono">
                  <UntrustedProse text={m.branch} />
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Commit</dt>
            <dd>
              {live ? (
                "Live"
              ) : commit ? (
                <>
                  <PinButton sha={commit} />
                  <span className="mt-1 block font-mono text-xs break-all select-text">
                    {commit}
                  </span>
                </>
              ) : null}
            </dd>
            {m?.committedAt && (
              <>
                <dt className="text-muted-foreground">Date</dt>
                <dd>
                  <TimeAgo iso={m.committedAt} />
                </dd>
              </>
            )}
            {m?.subject && (
              <>
                <dt className="text-muted-foreground">Subject</dt>
                <dd>
                  <UntrustedProse text={m.subject} />
                </dd>
              </>
            )}
          </dl>
          {d?.checkError && (
            <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[0.8125rem]">
              <RowState state="check_failed" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <UntrustedProse text={d.checkError} />
              </span>
            </p>
          )}
          <Outcome line={checkLine} />
          {/* Outside the Update section: a successful update clears the update, which unmounts that section. */}
          <Outcome line={updateLine} />
        </Section>

        {updateCommit !== null && (
          <Section title="Update">
            <div className="space-y-3 rounded-md border border-border bg-card p-3">
              <p className="text-[0.8125rem]">
                <span className="font-mono">
                  {(d?.update?.from ?? commit ?? "").slice(0, 7)} →{" "}
                  {(d?.update?.to ?? updateCommit ?? "").slice(0, 7)}
                </span>
                {d?.update?.committedAt && (
                  <>
                    {" · "}
                    <TimeAgo iso={d.update.committedAt} />
                  </>
                )}
                {d?.update?.subject && (
                  <>
                    {" · "}
                    <UntrustedProse text={d.update.subject} />
                  </>
                )}
              </p>
              <UpdateChanges view={d?.update} loading={!d} />
              <div className="space-y-1.5">
                <Button
                  size="sm"
                  aria-disabled={update.isPending || !d}
                  onClick={() => d && !update.isPending && onUpdate()}
                >
                  {update.isPending ? (
                    <Pending label="Updating…" since={update.submittedAt} />
                  ) : (
                    `Update Skills to ${(updateCommit ?? "").slice(0, 7)}`
                  )}
                </Button>
                <p className="text-[0.8125rem] text-muted-foreground">
                  Templates keep their pins. Move a pin in the template's Configuration.
                </p>
              </div>
            </div>
          </Section>
        )}

        {pinned.length > 0 && (
          <Section title="Pinned by templates">
            <ul className="space-y-1">
              {pinned.map((p) => (
                <li
                  key={p.template}
                  className="flex flex-wrap items-center gap-x-2 text-[0.8125rem]"
                >
                  <Link to="/templates/$name" params={{ name: p.template }} className={LINK}>
                    {p.template}
                  </Link>
                  <PinnedBy pin={p.pin} libraryCommit={commit} />
                </li>
              ))}
            </ul>
            <div className="mt-2 space-y-1.5">
              {[...unread].map(([id, u]) => (
                <UnreadPin
                  key={id}
                  name={name}
                  pinRef={u.ref}
                  isTag={u.isTag}
                  pluginName={u.plugin}
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="Plugins">
          {row ? (
            <ul>
              {plugins.map((p) => (
                <li
                  key={p.key}
                  className="flex min-h-7 flex-wrap items-center gap-x-3 text-[0.8125rem]"
                >
                  <button
                    type="button"
                    data-peek-key={pluginKey(p.key)}
                    aria-haspopup="dialog"
                    onClick={() => onOpen(pluginKey(p.key))}
                    className="min-w-0 text-left font-mono underline-offset-2 [overflow-wrap:anywhere] hover:underline"
                  >
                    <UntrustedProse text={p.name} />
                  </button>
                  {p.version && (
                    <span className="text-muted-foreground">{versionLabel(p.version)}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <SkeletonRows n={3} />
          )}
        </Section>
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-2">
        {inUse && (
          <p id={reasonId} className="text-[0.8125rem] text-muted-foreground">
            Templates use plugins from {visibleControls(name)}. Remove them first.
          </p>
        )}
        <Outcome line={removeLine} />
        <Button
          variant="ghost"
          aria-disabled={inUse || remove.isPending || !d}
          aria-describedby={inUse ? reasonId : undefined}
          onClick={onRemove}
          className="h-auto min-h-8 max-w-full self-end py-1.5 text-right whitespace-normal text-destructive hover:text-destructive pointer-coarse:h-auto pointer-coarse:min-h-10"
        >
          {remove.isPending ? (
            <Pending label="Removing…" since={remove.submittedAt} />
          ) : (
            `Remove marketplace (${count(plugins.length, "plugin")})`
          )}
        </Button>
      </SheetFooter>
    </>
  );
}
