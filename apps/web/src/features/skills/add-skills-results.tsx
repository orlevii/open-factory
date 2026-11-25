import type { foundSkillSchema } from "@open-factory/shared";
import { memo, useCallback, useId, useState } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { UntrustedProse, visibleControls } from "@/components/untrusted-text";
import { TimeAgo } from "@/features/settings/shared";
import { FORM_MSG } from "@/lib/form-messages";
import { count } from "./format";
import { focusAndReveal } from "./helpers";

export type Found = z.infer<typeof foundSkillSchema>;

/** Past this many results a filter field sits above the list (spec §10.4). */
export const FILTER_OVER = 20;

/** The ticked names as a `Set` with stable, functionally-updated handlers (R-F1): a tick re-renders only its own row. */
export function useTicks() {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const onTick = useCallback((name: string, on: boolean) => {
    setTicked((s) => {
      const next = new Set(s);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);
  /** Ticks (or unticks) exactly these names. */
  const onToggle = useCallback((names: string[], on: boolean) => {
    setTicked((s) => {
      const next = new Set(s);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });
  }, []);
  return { ticked, setTicked, onTick, onToggle };
}

/** Why a row can't be picked, in the spec's words. */
export function reasonOf(f: Found): string | undefined {
  if (f.pickable) return undefined;
  if (f.reason === "taken") return `Name taken by ${f.takenBy ?? "another source"}`;
  if (f.reason === "link") return "It's a link";
  return f.detail;
}

/** One result: primitive props and a stable `onTick`, so a tick re-renders only its own row. */
const FoundRow = memo(function FoundRow({
  name,
  description,
  reason,
  ticked,
  disabled,
  onTick,
}: {
  name: string;
  description: string;
  reason: string | undefined;
  ticked: boolean;
  disabled: boolean;
  onTick(name: string, on: boolean): void;
}) {
  const reasonId = useId();
  return (
    <li>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the Radix Checkbox is the labelable control; the whole row is its hit area */}
      <label className="flex items-start gap-2 py-1.5 text-[0.8125rem]">
        <Checkbox
          aria-label={name}
          aria-describedby={reason ? reasonId : undefined}
          checked={ticked}
          disabled={disabled}
          onCheckedChange={(c) => onTick(name, c === true)}
          className="mt-0.5"
        />
        <span className="min-w-0 flex-1">
          <span className="block font-mono [overflow-wrap:anywhere]">
            <UntrustedProse text={name} />
          </span>
          {description !== "" && (
            <span className="line-clamp-2 block text-muted-foreground">
              <UntrustedProse text={description} />
            </span>
          )}
          {reason !== undefined && (
            <span id={reasonId} className="block text-muted-foreground">
              <UntrustedProse text={reason} />
            </span>
          )}
        </span>
      </label>
    </li>
  );
});

export type FindResult = {
  /** What Find returned for this source. */
  found: Found[];
  /** A label for the source ("acme/x", or the folder path). */
  source: string;
  commit?: string;
  branch?: string;
  committedAt?: string;
  subject?: string;
};

/**
 * Step 1's results (spec §10.4). Everything shown is derived from props during render: the filtered rows, the toggle's
 * label and "None of these can be added." (R-F1). Ticks live in the sheet as a `Set` updated functionally.
 */
export function AddSkillsResults({
  result,
  seq,
  stale,
  ticked,
  filter,
  onFilter,
  onTick,
  onToggle,
}: {
  result: FindResult;
  /** Changes with every Find, so the label remounts and takes focus. */
  seq: number;
  stale: boolean;
  ticked: ReadonlySet<string>;
  filter: string;
  onFilter(v: string): void;
  onTick(name: string, on: boolean): void;
  /** Ticks (or unticks) exactly these names. */
  onToggle(names: string[], on: boolean): void;
}) {
  const { found } = result;
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ""
      ? found
      : found.filter(
          (f) =>
            f.name.toLowerCase().includes(needle) || f.description.toLowerCase().includes(needle),
        );
  const pickable = shown.filter((f) => f.pickable).map((f) => f.name);
  const allTicked = pickable.length > 0 && pickable.every((n) => ticked.has(n));
  const commit = result.commit?.slice(0, 7);

  if (found.length === 0) {
    return (
      <div className="space-y-1.5 text-[0.8125rem]">
        <p
          key={seq}
          ref={focusAndReveal}
          tabIndex={-1}
          className="outline-none" // ui-contract:allow programmatic focus target, not interactive
        >
          {visibleControls(`No skills in ${result.source}${commit ? ` at ${commit}` : ""}.`)} A
          skill is a folder with a SKILL.md.
        </p>
        {stale && <p className="text-muted-foreground">{FORM_MSG.sourceChanged}</p>}
      </div>
    );
  }
  const noneAddable = !found.some((f) => f.pickable);
  return (
    <section className="space-y-1.5" aria-label="Found skills">
      <div className="flex items-center justify-between gap-2">
        <p
          key={seq}
          ref={focusAndReveal}
          tabIndex={-1}
          className="text-[0.8125rem] font-medium outline-none" // ui-contract:allow programmatic focus target, not interactive
        >
          Found {count(found.length, "skill")}
        </p>
        {pickable.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            inForm
            disabled={stale}
            onClick={() => onToggle(pickable, !allTicked)}
          >
            {allTicked ? FORM_MSG.selectNone : FORM_MSG.selectAll}
          </Button>
        )}
      </div>
      <p className="text-[0.8125rem] text-muted-foreground">
        {stale ? (
          FORM_MSG.sourceChanged
        ) : commit ? (
          <>
            Found at <span className="font-mono">{commit}</span>
            {result.branch && <> · {visibleControls(result.branch)}</>}
            {result.committedAt && (
              <>
                {" · "}
                <TimeAgo iso={result.committedAt} />
              </>
            )}
            {result.subject && (
              <>
                {" · "}
                <UntrustedProse text={result.subject} />
              </>
            )}
          </>
        ) : null}
      </p>
      {found.length > FILTER_OVER && (
        <Input
          type="search"
          aria-label="Filter skills"
          placeholder="Filter skills"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          autoComplete="off"
          className="h-9"
        />
      )}
      {noneAddable && (
        <p className="text-[0.8125rem] text-muted-foreground">{FORM_MSG.noneAddable}</p>
      )}
      <ul>
        {shown.map((f) => (
          <FoundRow
            key={f.name}
            name={f.name}
            description={f.description}
            reason={reasonOf(f)}
            ticked={f.pickable && ticked.has(f.name)}
            disabled={stale || !f.pickable}
            onTick={onTick}
          />
        ))}
      </ul>
    </section>
  );
}
