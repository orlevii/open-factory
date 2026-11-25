import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import type { EmbedProps } from "@/features/settings/forms/form-frame";
import { refreshList, withItem } from "./add-to-list";
import { type DraftKey, draftGeneration, useSheetDraft } from "./drafts";

type Guard = { dirty(): boolean; attend(): void };

/**
 * The inline prerequisites a form hosts (Add credential, Add project, Add secret). Its submit asks `block()`: an open
 * expansion that holds input takes focus, says to add it or cancel it, and the submit does not go ahead.
 */
export function usePrerequisiteGuards() {
  const set = useRef(new Set<Guard>());
  return useMemo(
    () => ({
      register(g: Guard) {
        set.current.add(g);
        return () => void set.current.delete(g);
      },
      block(): boolean {
        for (const g of set.current) {
          if (!g.dirty()) continue;
          g.attend();
          return true;
        }
        return false;
      },
    }),
    [],
  );
}
export type PrerequisiteGuards = ReturnType<typeof usePrerequisiteGuards>;

type Saved = { open: boolean; values: Record<string, string> };
const CLOSED: Saved = { open: false, values: {} };
/** A plain path through `useSheetDraft`'s hook rules when a host keeps no draft (a dialog). */
const NO_DRAFT = "inline:none" as DraftKey;

/**
 * One inline prerequisite: an expansion under its field, opened by a disclosure trigger. It owns the open state and
 * the draft (names and methods, never a secret); the form inside is `embedded` and told what it needs through `embed`.
 *
 * Collapsing (Cancel, Esc, the trigger again) forgets the draft and returns focus to the trigger. `finish` is the
 * success path: it writes the new item into its list's cache in the same `flushSync` that selects it, collapses, then
 * focuses the field it served.
 */
export function useInlineAdd({
  draftKey,
  guards,
  noun,
}: {
  /** Kept across a closed sheet; none for a host that cannot be reopened with it (an MCP dialog row). */
  draftKey?: DraftKey;
  guards?: PrerequisiteGuards;
  /** "credential": the note when Create is pressed over unsaved input. */
  noun: string;
}) {
  const qc = useQueryClient();
  // This form's session: a sign-out bumps the generation, and nothing of it lands after.
  const [generation] = useState(draftGeneration);
  const draft = useSheetDraft<Saved>(draftKey ?? NO_DRAFT, () => CLOSED);
  const [open, setOpen] = useState(draft.start.open);
  // What the form last saved: a fold of its host (More options) remounts it with these, not the open-time seed.
  const latest = useRef(draft.start.values);
  // Restored open with the sheet: it does not take focus or scroll the sheet.
  const [fresh, setFresh] = useState(false);
  const [round, setRound] = useState(0);
  const [note, setNote] = useState<string>();
  const panelId = useId();
  const opener = useRef<HTMLElement | null>(null);
  const dirty = useRef(false);
  const alive = useRef(true);
  const keep = draftKey !== undefined;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const collapse = (focusOpener: boolean) => {
    if (keep) draft.clear();
    dirty.current = false;
    latest.current = {};
    setNote(undefined);
    setOpen(false);
    if (focusOpener) {
      const o = opener.current;
      // After the group is gone, so focus is not lost with it.
      queueMicrotask(() => o?.isConnected && o.focus());
    }
  };
  const expand = (trigger: HTMLElement, values?: Record<string, string>) => {
    opener.current = trigger;
    if (open && dirty.current) return attend();
    if (open && (values === undefined || JSON.stringify(values) === JSON.stringify(latest.current)))
      return collapse(true);
    if (values) {
      latest.current = values;
      setRound((r) => r + 1);
    }
    setFresh(true);
    setOpen(true);
  };
  function attend() {
    setNote(`Add the ${noun} or cancel it first.`);
    document.getElementById(panelId)?.focus();
  }
  useEffect(() => {
    if (!guards || !open) return;
    return guards.register({ dirty: () => dirty.current, attend });
  });

  // Stable: the form's effects depend on them.
  const onDirty = useCallback((d: boolean) => {
    dirty.current = d;
    if (!d) setNote(undefined);
  }, []);
  const saveDraft = draft.save;
  const save = useCallback(
    (values: Record<string, string>) => {
      latest.current = values;
      if (keep) saveDraft({ open: true, values });
    },
    [keep, saveDraft],
  );
  const embed: EmbedProps = {
    id: panelId,
    focusOnOpen: fresh,
    note,
    onDirty,
    start: latest.current,
    save,
  };

  /** A new item: in its list's cache and selected in one commit, the panel gone, focus on the field it served. */
  async function finish<I extends { name: string }>(
    queryKey: QueryKey,
    item: I,
    select: () => void,
    find: () => HTMLElement | null | undefined,
  ) {
    await qc.cancelQueries({ queryKey, exact: true });
    // Nothing lands after a sign-out: the item belongs to the old session.
    if (draftGeneration() !== generation) return;
    // A sheet that has closed meanwhile still gets the item in its list; there is nothing to select.
    if (!alive.current) {
      qc.setQueryData<I[]>(queryKey, (old) => (old === undefined ? old : withItem(item)(old)));
      refreshList(qc, queryKey);
      return;
    }
    flushSync(() => {
      qc.setQueryData<I[]>(queryKey, (old) => (old === undefined ? old : withItem(item)(old)));
      select();
      if (keep) draft.clear();
      dirty.current = false;
      latest.current = {};
      setNote(undefined);
      setOpen(false);
    });
    refreshList(qc, queryKey);
    const el = find();
    el?.scrollIntoView?.({ block: "nearest" });
    el?.focus();
  }

  return {
    open,
    /** The form's key: a new one re-seeds it. */
    round,
    embed,
    expand,
    cancel: () => collapse(true),
    finish,
    /** The disclosure trigger's own attributes. */
    triggerProps: {
      "aria-expanded": open,
      "aria-controls": open ? panelId : undefined,
    },
  };
}
export type InlineAdd = ReturnType<typeof useInlineAdd>;

/** The ghost "Add <noun>" disclosure that opens an inline prerequisite. */
export function InlineAddTrigger({
  add,
  children,
  seed,
  onOpen,
}: {
  add: InlineAdd;
  children: ReactNode;
  /** Values the form opens with (a secret's name). */
  seed?: Record<string, string>;
  onOpen?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      inForm
      data-skip-validate
      {...add.triggerProps}
      onClick={(e) => {
        onOpen?.();
        add.expand(e.currentTarget, seed);
      }}
    >
      <Plus aria-hidden="true" data-icon="inline-start" />
      {children}
    </Button>
  );
}
