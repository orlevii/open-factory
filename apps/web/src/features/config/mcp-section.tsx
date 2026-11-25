import { OVERLAY_LIMITS } from "@open-factory/shared";
import { Plus, X } from "lucide-react";
import {
  memo,
  type TransitionEvent,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { FieldNote, noteDescribedBy } from "@/components/field-note";
import { Button } from "@/components/ui/button";
import { IssueIcon } from "@/features/templates/issue-list";
import { arrive, useArrivalTint } from "@/lib/use-arrival";
import { cn } from "@/lib/utils";
import type { RowNote } from "./config-list";
import { FIELD_PATHS } from "./fields";
import { McpDialog } from "./mcp-dialog";
import {
  fromDraft,
  isFormShaped,
  type ServerDraft,
  serverKind,
  serverSummary,
  toDraft,
} from "./mcp-entry";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";
import { entryFor, placeNotes, withRest } from "./row-notes";
import { useConfigScope, useFieldNote } from "./scope";
import { Section, WrongType } from "./section";
import { isRec, readAt, readList } from "./tolerant";

const PATH = FIELD_PATHS.mcp;
const NONE: readonly string[] = [];

/** What a row may show of a server: its name, kind and summary. Built once per entry; never a value. */
type RowView = { name: string; kind?: string; summary?: string; editable: boolean };

function view(name: string, entry: unknown): RowView {
  if (!isFormShaped(entry)) return { name, editable: false };
  return {
    name,
    kind: serverKind(entry) === "url" ? CONFIG_COPY.kindUrl : CONFIG_COPY.kindCommand,
    summary: serverSummary(entry),
    editable: true,
  };
}

const servers = (r: unknown): [string, unknown][] => (isRec(r) ? Object.entries(r) : []);

/**
 * Which dialog is open: a server of this group by name, or a new one. `open` goes false while the dialog leaves, so
 * its content stays for the exit; `initial` is the kept draft for that server, or its stored entry.
 */
type Editing = { name: string | null; seq: number; open: boolean; initial: ServerDraft } | null;
/** Where focus goes when the dialog has closed: the row (tinted when a change was applied), else the Add button. */
type Landing = { name: string | null; tint: boolean };

/** Spec §12.2 section 3. */
export function McpSection() {
  return <McpField />;
}

function McpField() {
  const s = useConfigScope();
  const note = useFieldNote("mcp");
  const { update, mode, readOnly } = s;
  const [editing, setEditing] = useState<Editing>(null);
  // A dismissed dialog keeps its draft, per server (a new one under ""), for as long as the form lives.
  const drafts = useRef(new Map<string, ServerDraft>());
  const landing = useRef<Landing | null>(null);
  const seq = useRef(0);
  const groupId = useId();
  const reasonId = useId();
  const ownListEl = useRef<HTMLUListElement>(null);
  const addEl = useRef<HTMLButtonElement>(null);
  const { arrival, start, onArrivedEnd } = useArrivalTint();
  const [arrivedName, setArrivedName] = useState<string>();

  const own = readAt(s.value, PATH);
  const ownRec = own.ok && (own.value === undefined || isRec(own.value)) ? own.value : null;
  // Null without a base (template mode, or a broken template): no "From template" group.
  const baseRead = s.base ? readAt(s.base, PATH) : null;
  const tplRaw = baseRead ? (baseRead.ok ? baseRead.value : undefined) : null;
  const inheritedEntries = useMemo(() => (tplRaw === null ? null : servers(tplRaw)), [tplRaw]);
  const ownEntries = useMemo(() => servers(ownRec), [ownRec]);
  const ownViews = useMemo(() => ownEntries.map(([n, e]) => view(n, e)), [ownEntries]);
  const tplViews = useMemo(
    () => inheritedEntries?.map(([n, e]) => view(n, e)) ?? null,
    [inheritedEntries],
  );
  const ownNames = useMemo(() => new Set(ownEntries.map(([n]) => n)), [ownEntries]);

  // Secrets already listed, so an Insert secret of one of them adds nothing.
  const ownSecrets = readList(readAt(s.value, FIELD_PATHS.envSecrets));
  const tplSecrets = s.base ? readList(readAt(s.base, FIELD_PATHS.envSecrets)) : null;
  const ownSecretItems = ownSecrets.ok ? ownSecrets.items : NONE;
  const tplSecretItems = tplSecrets?.ok ? tplSecrets.items : NONE;
  const knownSecrets = useMemo(
    () => new Set([...ownSecretItems, ...tplSecretItems]),
    [ownSecretItems, tplSecretItems],
  );

  const items = s.byField.get("mcp")?.items;
  // Issue paths run below the server name (`gh.env.T`), and a name may hold dots (`ctx.io`): each goes to the longest
  // server name it starts with, in either group. One with no row goes to the field's note (review I1).
  const { rows: rowNotes, rest } = useMemo(() => {
    const names = [...ownNames, ...(inheritedEntries ?? []).map(([n]) => n)].sort(
      (a, b) => b.length - a.length,
    );
    return placeNotes(items, (k) => entryFor(k, names));
  }, [items, ownNames, inheritedEntries]);
  const shown = withRest(note, rest);

  const ownEntriesRef = useRef(ownEntries);
  useLayoutEffect(() => {
    ownEntriesRef.current = ownEntries;
  });
  // `entry`: the server's stored value, when the draft holding it hasn't committed yet (an override).
  const open = useCallback((name: string | null, entry?: unknown) => {
    const stored = name === null ? undefined : ownEntriesRef.current.find(([n]) => n === name)?.[1];
    const source = entry ?? stored;
    seq.current += 1;
    setEditing({
      name,
      seq: seq.current,
      open: true,
      initial:
        drafts.current.get(name ?? "") ?? toDraft(name ?? "", isRec(source) ? source : undefined),
    });
  }, []);

  const openEdit = useCallback((name: string) => open(name), [open]);

  const remove = useCallback(
    (name: string, index: number) => {
      flushSync(() => {
        drafts.current.delete(name);
        update(PATH, (prev) => {
          if (!isRec(prev)) return prev;
          return Object.fromEntries(Object.entries(prev).filter(([k]) => k !== name));
        });
      });
      const rows = ownListEl.current?.children;
      const row = rows?.[index] ?? rows?.[index - 1];
      (row?.querySelector<HTMLElement>("button[data-remove]") ?? addEl.current)?.focus();
    },
    [update],
  );

  // Override: the template's entry, copied whole into this agent's servers, then edited there.
  const override = useCallback(
    (name: string) => {
      const entry = inheritedEntries?.find(([n]) => n === name)?.[1];
      if (entry === undefined) return;
      update([...PATH, name], () => structuredClone(entry));
      // An entry the form can't edit is copied as it is; its row then reads "Edit this in Raw JSON." (review M2).
      if (isFormShaped(entry)) open(name, entry);
    },
    [inheritedEntries, update, open],
  );

  const addSecret = useCallback(
    (name: string) =>
      update(FIELD_PATHS.envSecrets, (prev) =>
        Array.isArray(prev) ? (prev.includes(name) ? prev : [...prev, name]) : [name],
      ),
    [update],
  );

  const closeDialog = () => setEditing((e) => (e ? { ...e, open: false } : e));

  const apply = (d: ServerDraft, original: string | null) => {
    const name = d.name.trim();
    const entry = fromDraft(d);
    update(PATH, (prev) => {
      const entries = isRec(prev) ? Object.entries(prev) : [];
      // A rename keeps the server's place; a new one goes last.
      const at = original === null ? -1 : entries.findIndex(([k]) => k === original);
      const kept = entries.filter(([k]) => k !== name || k === original);
      if (at < 0) return Object.fromEntries([...kept, [name, entry]]);
      return Object.fromEntries(kept.map(([k, v]) => (k === original ? [name, entry] : [k, v])));
    });
    drafts.current.delete(original ?? "");
    landing.current = { name, tint: true };
    closeDialog();
  };

  const dismiss = (d: ServerDraft) => {
    if (!editing) return;
    drafts.current.set(editing.name ?? "", d);
    landing.current = { name: editing.name, tint: false };
    closeDialog();
  };

  const land = (e: Event) => {
    e.preventDefault();
    const at = landing.current;
    landing.current = null;
    const row =
      at?.name != null
        ? ownListEl.current?.querySelector<HTMLElement>(`[data-mcp-row="${CSS.escape(at.name)}"]`)
        : null;
    if (!row) return addEl.current?.focus();
    arrive(row);
    if (at?.tint) {
      setArrivedName(at.name ?? undefined);
      start();
    }
  };

  if (ownRec === null) return <WrongType field="mcp" label="MCP servers" />;

  const atLimit = ownEntries.length >= OVERLAY_LIMITS.mcpServers;
  // At the limit Add stays focusable and says why, beside it.
  const addServer = readOnly ? null : (
    <span className="flex items-center gap-2">
      {atLimit ? (
        <span id={reasonId} className="text-[0.8125rem] text-muted-foreground">
          {CONFIG_FIELD_MSG.tooManyServers}
        </span>
      ) : null}
      <Button
        ref={addEl}
        type="button"
        variant="ghost"
        size="sm"
        aria-disabled={atLimit || undefined}
        aria-describedby={atLimit ? reasonId : undefined}
        aria-haspopup="dialog"
        onClick={() => !atLimit && open(null)}
      >
        <Plus aria-hidden="true" />
        {CONFIG_COPY.addServer}
      </Button>
    </span>
  );

  const taken = new Set(ownNames);
  if (editing?.name != null) taken.delete(editing.name);

  const ownList = (
    <ul
      ref={ownListEl}
      aria-labelledby={tplViews ? `${groupId}-own` : undefined}
      className="grid gap-1"
    >
      {ownViews.map((v, i) => (
        <li
          key={v.name}
          data-mcp-row={v.name}
          tabIndex={-1}
          className="rounded-md outline-none"
          {...(arrivedName === v.name && arrival
            ? {
                "data-arrived": arrival === "fading" ? "fading" : "",
                onTransitionEnd: (e: TransitionEvent<HTMLLIElement>) => {
                  if (e.target !== e.currentTarget || arrival !== "fading") return;
                  if (e.propertyName && e.propertyName !== "opacity") return;
                  onArrivedEnd();
                },
              }
            : {})}
        >
          <ServerRow
            view={v}
            index={i}
            note={rowNotes.get(v.name)}
            onEdit={readOnly || !v.editable ? undefined : openEdit}
            onRemove={readOnly ? undefined : remove}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <Section title="MCP servers" action={tplViews ? undefined : addServer}>
      <fieldset
        data-field=""
        className="grid min-w-0 gap-1.5"
        aria-describedby={noteDescribedBy("field-mcp", {
          error: shown.error,
          warning: shown.warning,
        })}
        aria-invalid={shown.error ? true : undefined}
      >
        <legend className="sr-only">MCP servers</legend>
        <div className="grid gap-2">
          {tplViews ? (
            <div className="grid gap-1">
              <p id={`${groupId}-tpl`} className="text-[0.8125rem] text-muted-foreground">
                {s.inheritedLabel} · {tplViews.length}
              </p>
              <ul aria-labelledby={`${groupId}-tpl`} className="grid gap-1">
                {tplViews.map((v) => (
                  <li key={v.name}>
                    <ServerRow
                      view={v}
                      overridden={ownNames.has(v.name)}
                      note={ownNames.has(v.name) ? undefined : rowNotes.get(v.name)}
                      onOverride={readOnly ? undefined : override}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {tplViews ? (
            <div className="grid gap-1">
              <div className="flex min-h-7 items-center justify-between gap-2">
                <p id={`${groupId}-own`} className="text-[0.8125rem] text-muted-foreground">
                  {CONFIG_COPY.thisAgent} · {ownViews.length}
                </p>
                {addServer}
              </div>
              {ownList}
            </div>
          ) : (
            ownList
          )}
        </div>
        <FieldNote id="field-mcp" error={shown.error} warning={shown.warning} />
      </fieldset>
      {editing ? (
        <McpDialog
          key={editing.seq}
          open={editing.open}
          initial={editing.initial}
          original={editing.name}
          taken={taken}
          knownSecrets={knownSecrets}
          mode={mode}
          onAddSecret={addSecret}
          onApply={apply}
          onDismiss={dismiss}
          onCloseAutoFocus={land}
        />
      ) : null}
    </Section>
  );
}

/**
 * One server: line 1 is the name (a button that opens its dialog, when editable; wrapping) and the kind, line 2 the muted summary. The args, the full URL, the
 * headers and env values are never shown here: tokens hide in them.
 */
const ServerRow = memo(function ServerRow({
  view: v,
  index = 0,
  note,
  overridden,
  onEdit,
  onRemove,
  onOverride,
}: {
  view: RowView;
  index?: number;
  note?: RowNote;
  /** A template server this agent replaces. */
  overridden?: boolean;
  onEdit?: (name: string) => void;
  onRemove?: (name: string, index: number) => void;
  onOverride?: (name: string) => void;
}) {
  const noteId = useId();
  return (
    <div className="flex min-h-8 items-start gap-2 rounded-md px-2 pointer-coarse:min-h-10">
      <div className="min-w-0 flex-1 py-1.5">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          {onEdit ? (
            <button
              type="button"
              data-edit={v.name}
              aria-haspopup="dialog"
              aria-describedby={note ? noteId : undefined}
              className="-mx-1 min-w-0 rounded-sm px-1 text-left font-mono text-[0.8125rem] underline-offset-4 [overflow-wrap:anywhere] hover:underline"
              onClick={() => onEdit(v.name)}
            >
              {v.name}
            </button>
          ) : (
            <span className="min-w-0 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
              {v.name}
            </span>
          )}
          {v.kind ? <span className="text-[0.8125rem] text-muted-foreground">{v.kind}</span> : null}
        </p>
        {v.summary ? (
          <p className="text-[0.8125rem] text-muted-foreground [overflow-wrap:anywhere]">
            {v.summary}
          </p>
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">{CONFIG_FIELD_MSG.editInRaw}</p>
        )}
        {note ? (
          <p
            id={noteId}
            className={cn(
              "flex items-start gap-1.5 pt-1 text-[0.8125rem]",
              note.severity === "error" ? "text-destructive" : "text-foreground",
            )}
          >
            <IssueIcon severity={note.severity} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{note.message}</span>
          </p>
        ) : null}
      </div>
      {overridden ? (
        <span className="shrink-0 py-1.5 text-[0.8125rem] text-muted-foreground">
          {CONFIG_COPY.overridden}
        </span>
      ) : onOverride ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          aria-label={`${CONFIG_COPY.override} ${v.name}`}
          onClick={() => onOverride(v.name)}
        >
          {CONFIG_COPY.override}
        </Button>
      ) : null}
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-0.5 shrink-0"
          data-remove=""
          aria-label={`Remove ${v.name}`}
          aria-describedby={note ? noteId : undefined}
          onClick={() => onRemove(v.name, index)}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
});
