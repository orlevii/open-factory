import { OVERLAY_LIMITS } from "@open-factory/shared";
import { Pencil, Plus, X } from "lucide-react";
import { memo, useCallback, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { Button } from "@/components/ui/button";
import { IssueIcon } from "@/features/templates/issue-list";
import { cn } from "@/lib/utils";
import type { RowNote } from "./config-list";
import { FIELD_PATHS } from "./fields";
import { McpEditor } from "./mcp-editor";
import {
  fromDraft,
  isFormShaped,
  type ServerDraft,
  serverKind,
  serverSummary,
  toDraft,
} from "./mcp-entry";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";
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

/** Which editor is open: a server of this group by name, or a new one. */
type Editing = { name: string | null; seq: number } | null;

/** Spec §12.2 section 3. */
export function McpSection() {
  return (
    <Section title="MCP servers">
      <McpField />
    </Section>
  );
}

function McpField() {
  const s = useConfigScope();
  const note = useFieldNote("mcp");
  const { update, fieldErrors, mode, readOnly } = s;
  const [editing, setEditing] = useState<Editing>(null);
  const seq = useRef(0);
  const groupId = useId();
  const ownListEl = useRef<HTMLUListElement>(null);
  const addEl = useRef<HTMLButtonElement>(null);

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

  const open = useCallback((name: string | null) => {
    seq.current += 1;
    flushSync(() => setEditing({ name, seq: seq.current }));
    document.getElementById("field-mcp-name")?.focus();
  }, []);

  const remove = useCallback(
    (name: string, index: number) => {
      flushSync(() => {
        update(PATH, (prev) => {
          if (!isRec(prev)) return prev;
          return Object.fromEntries(Object.entries(prev).filter(([k]) => k !== name));
        });
        setEditing((e) => (e?.name === name ? null : e));
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
      open(name);
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

  const close = (name: string | null) => {
    flushSync(() => setEditing(null));
    const target =
      name === null
        ? addEl.current
        : document.querySelector<HTMLElement>(`[data-edit="${CSS.escape(name)}"]`);
    (target ?? addEl.current)?.focus();
  };

  const save = (d: ServerDraft, original: string | null) => {
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
    close(name);
  };

  const startAdd = () => {
    if (ownEntries.length >= OVERLAY_LIMITS.mcpServers) {
      fieldErrors.set("mcp", CONFIG_FIELD_MSG.tooManyServers);
      return;
    }
    open(null);
  };

  if (ownRec === null) return <WrongType field="mcp" label="MCP servers" />;

  const editor = (name: string | null) => {
    if (!editing || editing.name !== name) return null;
    const entry = name === null ? undefined : ownEntries.find(([n]) => n === name)?.[1];
    const taken = new Set(ownNames);
    if (name !== null) taken.delete(name);
    return (
      <McpEditor
        key={editing.seq}
        initial={toDraft(name ?? "", isRec(entry) ? entry : undefined)}
        original={name}
        taken={taken}
        knownSecrets={knownSecrets}
        mode={mode}
        onAddSecret={addSecret}
        onDone={save}
        onCancel={() => close(name)}
      />
    );
  };

  const ownList = (
    <ul
      ref={ownListEl}
      aria-labelledby={tplViews ? `${groupId}-own` : undefined}
      className="grid gap-1"
    >
      {ownViews.map((v, i) => (
        <li key={v.name} className="grid gap-2">
          <ServerRow
            view={v}
            index={i}
            note={items?.get(v.name)}
            onEdit={readOnly || !v.editable ? undefined : open}
            onRemove={readOnly ? undefined : remove}
          />
          {editor(v.name)}
        </li>
      ))}
    </ul>
  );

  return (
    <FieldShell name="mcp" label="MCP servers" legend error={note.error} warning={note.warning}>
      {() => (
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
                      onOverride={readOnly ? undefined : override}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {tplViews ? (
            <div className="grid gap-1">
              <p id={`${groupId}-own`} className="text-[0.8125rem] text-muted-foreground">
                {CONFIG_COPY.thisAgent} · {ownViews.length}
              </p>
              {ownList}
            </div>
          ) : (
            ownList
          )}
          {editor(null)}
          {readOnly || editing?.name === null ? null : (
            <Button
              ref={addEl}
              type="button"
              variant="ghost"
              size="sm"
              className="justify-self-start"
              onClick={startAdd}
            >
              <Plus aria-hidden="true" />
              {CONFIG_COPY.addServer}
            </Button>
          )}
        </div>
      )}
    </FieldShell>
  );
}

/**
 * One server: line 1 is the name (wrapping) and the kind, line 2 the muted summary. The args, the full URL, the
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
          <span className="min-w-0 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
            {v.name}
          </span>
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
      {onEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-0.5 shrink-0"
          data-edit={v.name}
          aria-label={`Edit ${v.name}`}
          aria-describedby={note ? noteId : undefined}
          onClick={() => onEdit(v.name)}
        >
          <Pencil aria-hidden="true" />
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
