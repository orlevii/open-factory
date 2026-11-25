import { pinOf, pinRefFor, type pluginDiffSchema } from "@open-factory/shared";
import { useMutation } from "@tanstack/react-query";
import { type KeyboardEvent, memo, useRef, useState } from "react";
import type { z } from "zod";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuTrigger,
} from "@/components/ui/adaptive-menu";
import { Button } from "@/components/ui/button";
import { visibleControls } from "@/components/untrusted-text";
import { PinButton, SkeletonRows } from "@/features/skills/peeks/sections";
import { ChangedHeader, DiffLine, hookText } from "@/features/skills/peeks/update-view";
import { diffPlugin, type MarketplaceRow } from "@/lib/library";
import { LatestBadge } from "./latest-badge";
import { CONFIG_COPY, PLUGIN_COPY } from "./messages";

type Diff = z.infer<typeof pluginDiffSchema>;
const COMMIT = /^[0-9a-f]{40}$/;

/** A pin as it is shown: a commit's seven characters, a tag's name. */
export const shortRef = (ref: string) => (COMMIT.test(ref) ? ref.slice(0, 7) : ref);

/** What the pin says, as items: "Pinned · a1b2c3d", the Latest badge or "Local folder, live". */
function PinFacts({ decl, library }: { decl: unknown; library: string | null | undefined }) {
  const pin = pinOf(decl);
  if (pin.kind === "live") return <span>{CONFIG_COPY.localLive}</span>;
  if (pin.kind === "latest") return <LatestBadge />;
  if (pin.kind === "tag")
    return (
      <span>
        {CONFIG_COPY.pinned} · tag <span className="font-mono">{visibleControls(pin.name)}</span>
      </span>
    );
  return (
    <>
      <span className="inline-flex items-center gap-1">
        <span>{CONFIG_COPY.pinned} ·</span>
        <PinButton sha={pin.sha} />
      </span>
      {library && library !== pin.sha ? (
        <span className="text-muted-foreground">
          {CONFIG_COPY.newerInSkills} <span className="font-mono">{library.slice(0, 7)}</span>
        </span>
      ) : null}
    </>
  );
}

const NO_DIFFS: readonly Diff[] = [];
type Review = { kind: "pin"; to: string } | { kind: "latest" } | null;
type DiffVars = { id: string; keys: readonly string[]; from: string; to: string };

/** A diff line per change of one plugin, removals first within each kind. */
function diffLines(d: Diff["diff"]): { sign: "+" | "−"; text: string }[] {
  const mcp = (m: { name: string; command: string | null; url: string | null }) =>
    `MCP ${m.name}: ${m.command ?? m.url ?? ""}`;
  const part = (c: { kind: string; items: string[] }) => `${c.kind}: ${c.items.join(", ")}`;
  const both = <T,>(c: { added: T[]; removed: T[] }, text: (t: T) => string) => [
    ...c.removed.map((t) => ({ sign: "−" as const, text: text(t) })),
    ...c.added.map((t) => ({ sign: "+" as const, text: text(t) })),
  ];
  return [
    ...both(d.hooks, hookText),
    ...both(d.mcp, mcp),
    ...both(d.codeParts, part),
    ...both(d.commands, (c) => `command ${c}`),
    ...both(d.dependencies, (c) => `dependency ${c}`),
    ...both(d.needs, (c) => `needs ${c}`),
  ];
}

function PluginDiff({ d }: { d: Diff }) {
  const lines = diffLines(d.diff);
  return (
    <li className="space-y-1">
      <ChangedHeader name={d.key} runsCodeChanged={d.diff.runsCode} />
      {!d.to.present && (
        <DiffLine sign="−" text={PLUGIN_COPY.notInCatalog(shortRef(d.to.commit))} />
      )}
      {!d.from.present && (
        <DiffLine sign="+" text={PLUGIN_COPY.newSince(shortRef(d.from.commit))} />
      )}
      {lines.map((l, i) => (
        <DiffLine
          // biome-ignore lint/suspicious/noArrayIndexKey: two changes can read the same, and the list is static
          key={`${i}\0${l.sign}${l.text}`}
          sign={l.sign}
          text={l.text}
        />
      ))}
    </li>
  );
}

/** Plugins that run code differently first, whatever order they came in (a stable sort). */
const byRunsCode = (ds: readonly Diff[]) =>
  [...ds].sort((a, b) => Number(b.diff.runsCode) - Number(a.diff.runsCode));

/**
 * A review opens with its heading focused (the rule Add skills' results use). The menu that opened it is closing: its
 * focus trap would hand focus back to the menu item, so the focus waits a tick. Module-level, so it is stable.
 */
function focusHeading(el: HTMLElement | null) {
  if (!el) return;
  const t = setTimeout(() => el.focus({ preventScroll: true }), 0);
  return () => clearTimeout(t);
}

const ReviewPanel = memo(function ReviewPanel({
  heading,
  primary,
  danger,
  disabled,
  onConfirm,
  onCancel,
  children,
}: {
  heading: string;
  primary: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onCancel();
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a review is a named group inside the form, not a fieldset
    <div
      role="group"
      aria-label={heading}
      onKeyDown={onKeyDown}
      className="grid min-w-0 grid-cols-1 gap-3 rounded-md border border-border bg-card p-3 [overflow-wrap:anywhere]"
    >
      <h4
        ref={focusHeading}
        tabIndex={-1}
        className="text-[0.8125rem] font-medium outline-none" // ui-contract:allow programmatic focus target, not interactive
      >
        {heading}
      </h4>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={danger ? "ghost" : "default"}
          inForm
          className={danger ? "text-destructive hover:text-destructive" : undefined}
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) onConfirm();
          }}
        >
          {primary}
        </Button>
        <Button type="button" variant="ghost" inForm onClick={onCancel}>
          {CONFIG_COPY.cancel}
        </Button>
      </div>
    </div>
  );
});

/** The diff of every plugin the template uses from the marketplace, or why there is none to show. */
function DiffBody({
  hasFrom,
  status,
  diffs,
  onRetry,
}: {
  hasFrom: boolean;
  status: "pending" | "error" | "done";
  diffs: readonly Diff[];
  onRetry: () => void;
}) {
  if (!hasFrom) return <p className="text-[0.8125rem]">{CONFIG_COPY.pinningFromLatest}</p>;
  if (status === "pending")
    return (
      <div role="status">
        <span className="sr-only">{PLUGIN_COPY.loadingDiff}</span>
        <SkeletonRows n={3} />
      </div>
    );
  if (status === "error")
    return (
      <div className="flex items-center gap-2 text-[0.8125rem]">
        <span className="text-destructive">{CONFIG_COPY.couldntLoadDiff}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          {CONFIG_COPY.retry}
        </Button>
      </div>
    );
  if (diffs.length === 0) return <p className="text-[0.8125rem]">{CONFIG_COPY.noChangesShown}</p>;
  return (
    <ul className="grid gap-2">
      {byRunsCode(diffs).map((d) => (
        <PluginDiff key={d.key} d={d} />
      ))}
    </ul>
  );
}

/**
 * A marketplace's pin in its group's label row (spec §10.5): what it is pinned to, and, when editable, "Change pin"
 * with its reviews in place under the row. The pin is the declaration's `source.ref`; a review's primary writes (or
 * removes) it through `onPin`, and the form's dirty footer takes over. The diff is a mutation started from the menu
 * item's handler and kept in the mutation's own state, which reads as dropped once its commits no longer match.
 */
export const PinControl = memo(function PinControl({
  marketplace,
  decl,
  row,
  keys,
  editable,
  onPin,
}: {
  marketplace: string;
  decl: unknown;
  row: MarketplaceRow | undefined;
  /** The plugins this template uses from the marketplace. */
  keys: readonly string[];
  editable: boolean;
  onPin: (marketplace: string, ref: string | undefined) => void;
}) {
  const pin = pinOf(decl);
  const current = pin.kind === "commit" ? pin.sha : pin.kind === "tag" ? pin.name : undefined;
  const target = row ? pinRefFor(row) : undefined;
  const trigger = useRef<HTMLButtonElement>(null);
  const handoff = useRef(false);
  const [review, setReview] = useState<Review>(null);
  const diff = useMutation({
    mutationFn: ({ keys, from, to }: DiffVars) =>
      Promise.all(keys.map((k) => diffPlugin(k, from, to))),
  });

  const pinTo = target !== undefined && target !== current ? target : undefined;
  const canPin = pinTo !== undefined;
  const canLatest = current !== undefined;
  const menu = editable && pin.kind !== "live" && (canPin || canLatest);

  const startPin = (to: string) => {
    setReview({ kind: "pin", to });
    if (current !== undefined)
      diff.mutate({ id: `${marketplace}\0${current}\0${to}`, keys, from: current, to });
  };
  const close = () => {
    setReview(null);
    trigger.current?.focus();
  };

  const id =
    review?.kind === "pin" && current !== undefined
      ? `${marketplace}\0${current}\0${review.to}`
      : undefined;
  const mine = id !== undefined && diff.variables?.id === id ? diff : undefined;
  const status = !mine || mine.isPending ? "pending" : mine.isError ? "error" : "done";

  return (
    <>
      <PinFacts decl={decl} library={editable ? row?.commit : undefined} />
      {menu ? (
        <AdaptiveMenu title={`${CONFIG_COPY.changePin}: ${marketplace}`}>
          <AdaptiveMenuTrigger asChild>
            <Button
              ref={trigger}
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${CONFIG_COPY.changePin} for ${marketplace}`}
              className="whitespace-nowrap"
            >
              {CONFIG_COPY.changePin}
            </Button>
          </AdaptiveMenuTrigger>
          <AdaptiveMenuContent
            align="end"
            onCloseAutoFocus={(e) => {
              if (!handoff.current) return;
              // A review opened: its heading has the focus.
              handoff.current = false;
              e.preventDefault();
            }}
          >
            {pinTo !== undefined ? (
              <AdaptiveMenuItem
                onSelect={() => {
                  handoff.current = true;
                  startPin(pinTo);
                }}
              >
                {PLUGIN_COPY.pinTo(shortRef(pinTo), pin.kind !== "latest")}
              </AdaptiveMenuItem>
            ) : null}
            {canLatest ? (
              <AdaptiveMenuItem
                onSelect={() => {
                  handoff.current = true;
                  setReview({ kind: "latest" });
                }}
              >
                {CONFIG_COPY.useLatestItem}
              </AdaptiveMenuItem>
            ) : null}
          </AdaptiveMenuContent>
        </AdaptiveMenu>
      ) : null}
      {review ? (
        <div className="min-w-0 basis-full">
          {review.kind === "pin" ? (
            <ReviewPanel
              heading={PLUGIN_COPY.pinHeading(marketplace, shortRef(review.to))}
              primary={PLUGIN_COPY.pinPrimary(shortRef(review.to))}
              disabled={current !== undefined && status !== "done"}
              onConfirm={() => {
                onPin(marketplace, review.to);
                close();
              }}
              onCancel={close}
            >
              <DiffBody
                hasFrom={current !== undefined}
                status={status}
                diffs={mine?.data ?? NO_DIFFS}
                onRetry={() => startPin(review.to)}
              />
            </ReviewPanel>
          ) : (
            <ReviewPanel
              heading={PLUGIN_COPY.latestHeading(marketplace)}
              primary={CONFIG_COPY.useLatest}
              danger
              onConfirm={() => {
                onPin(marketplace, undefined);
                close();
              }}
              onCancel={close}
            >
              <p className="text-[0.8125rem]">{PLUGIN_COPY.latestRisk(marketplace)}</p>
            </ReviewPanel>
          )}
        </div>
      ) : null}
    </>
  );
});
