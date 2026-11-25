import { Plus, X } from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { focusField } from "@/components/forms/focus-field";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { returnFocusAfterChild } from "@/features/sheets/sheet-store";
import { type Caret, InsertSecret, insertReference } from "./insert-secret";
import {
  checkName,
  checkUrl,
  type EditorField,
  firstInvalidField,
  newPair,
  type Pair,
  pairErrors,
  type ServerDraft,
  type ServerKind,
} from "./mcp-entry";
import { CONFIG_COPY, CONFIG_FIELD_MSG, secretAddedNote } from "./messages";
import type { ConfigMode } from "./scope";

const EDITOR_FIELDS: readonly EditorField[] = ["mcp-name", "mcp-command", "mcp-url"];
const KIND_FIELDS: Readonly<Record<ServerKind, readonly EditorField[]>> = {
  command: ["mcp-name", "mcp-command"],
  url: ["mcp-name", "mcp-url"],
};
const KINDS = [
  { value: "command", label: CONFIG_COPY.kindCommand },
  { value: "url", label: CONFIG_COPY.kindUrl },
] as const;
type PairList = "env" | "headers";

/**
 * The MCP server dialog (spec §2.5, §4.3), a drawer below `md`; add and edit share it. It holds its own draft until
 * Apply, so switching kind keeps what was typed in the other kind's fields; only the chosen kind is saved. Dismissing
 * (Esc, scrim, Cancel) hands the draft to `onDismiss` and never asks. Values (args, env, URL, headers) appear only
 * inside these inputs.
 */
export function McpDialog({
  open,
  initial,
  original,
  taken,
  knownSecrets,
  mode,
  onAddSecret,
  onApply,
  onDismiss,
  onCloseAutoFocus,
}: {
  open: boolean;
  initial: ServerDraft;
  /** The name the server had (null for a new one): renaming replaces it in place. */
  original: string | null;
  /** The other servers' names in this group, for the duplicate check. */
  taken: ReadonlySet<string>;
  /** Secrets already listed (this agent's and the template's): picking one of those adds nothing. */
  knownSecrets: ReadonlySet<string>;
  mode: ConfigMode;
  onAddSecret: (name: string) => void;
  onApply: (draft: ServerDraft, original: string | null) => void;
  /** Closed without applying: the caller keeps the draft for this server. */
  onDismiss: (draft: ServerDraft) => void;
  onCloseAutoFocus: (e: Event) => void;
}) {
  const [d, setD] = useState(initial);
  // Pair name errors show once a pair name is left, or after Apply.
  const [touched, setTouched] = useState<ReadonlySet<number> | "all">(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const kindName = useId();

  const fieldErrors = useFieldErrors<EditorField>({
    form: root,
    checks: {
      "mcp-name": () => checkName(d.name, taken),
      "mcp-command": () => (d.command.trim() ? undefined : CONFIG_FIELD_MSG.enterCommand),
      "mcp-url": () => checkUrl(d.url),
    },
    fields: EDITOR_FIELDS,
  });

  const list: PairList = d.kind === "command" ? "env" : "headers";
  const shownPairs = d[list];
  const errors = useMemo(
    () => pairErrors(list === "env" ? "env" : "header", shownPairs),
    [list, shownPairs],
  );

  const patchPair = useCallback(
    (which: PairList, id: number, patch: Partial<Pair>) =>
      setD((p) => ({ ...p, [which]: p[which].map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
    [],
  );
  const removePair = useCallback(
    (which: PairList, id: number) =>
      setD((p) => ({ ...p, [which]: p[which].filter((x) => x.id !== id) })),
    [],
  );
  const touch = useCallback(
    (id: number) => setTouched((t) => (t === "all" || t.has(id) ? t : new Set(t).add(id))),
    [],
  );
  const onSecret = useCallback(
    (name: string) => {
      if (knownSecrets.has(name)) return false;
      onAddSecret(name);
      return true;
    },
    [knownSecrets, onAddSecret],
  );

  const apply = () => {
    flushSync(() => setTouched("all"));
    if (!fieldErrors.submit(KIND_FIELDS[d.kind])) return;
    if (errors.size > 0) {
      focusField(root.current);
      return;
    }
    onApply(d, original);
  };
  const enterDone = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    apply();
  };
  const text =
    (f: EditorField, key: "name" | "command" | "url") => (e: { target: { value: string } }) => {
      fieldErrors.change(f);
      setD((p) => ({ ...p, [key]: e.target.value }));
    };

  const focusStart = (e: Event) => {
    e.preventDefault();
    document
      .getElementById(`field-${original ? firstInvalidField(initial, taken) : "mcp-name"}`)
      ?.focus();
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss(d);
      }}
      title={original ? `Edit ${original}` : CONFIG_COPY.addServer}
      onOpenAutoFocus={focusStart}
      onCloseAutoFocus={onCloseAutoFocus}
      primary={
        <Button type="button" inForm onClick={apply}>
          {original ? CONFIG_COPY.applyChanges : CONFIG_COPY.addServer}
        </Button>
      }
    >
      <div ref={root} className="grid min-w-0 gap-4">
        <FieldShell name="mcp-name" label="Name" error={fieldErrors.errors["mcp-name"]}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              value={d.name}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={text("mcp-name", "name")}
              onBlur={(e) => fieldErrors.blur("mcp-name", e)}
              onKeyDown={enterDone}
            />
          )}
        </FieldShell>
        <SegmentedControl
          legend="Kind"
          legendVisible
          name={kindName}
          value={d.kind}
          options={KINDS}
          onChange={(kind) => setD((p) => ({ ...p, kind }))}
        />
        {d.kind === "command" ? (
          <>
            <FieldShell
              name="mcp-command"
              label="Command"
              error={fieldErrors.errors["mcp-command"]}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  value={d.command}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="npx"
                  className="font-mono"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  onChange={text("mcp-command", "command")}
                  onBlur={(e) => fieldErrors.blur("mcp-command", e)}
                  onKeyDown={enterDone}
                />
              )}
            </FieldShell>
            <FieldShell name="mcp-args" label="Arguments" help={CONFIG_COPY.argsHelp}>
              {({ id, describedBy }) => (
                <Textarea
                  id={id}
                  value={d.args}
                  spellCheck={false}
                  className="font-mono text-[0.8125rem]"
                  aria-describedby={describedBy}
                  onChange={(e) => setD((p) => ({ ...p, args: e.target.value }))}
                />
              )}
            </FieldShell>
          </>
        ) : (
          <FieldShell name="mcp-url" label="URL" error={fieldErrors.errors["mcp-url"]}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                value={d.url}
                type="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://"
                className="font-mono"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={text("mcp-url", "url")}
                onBlur={(e) => fieldErrors.blur("mcp-url", e)}
                onKeyDown={enterDone}
              />
            )}
          </FieldShell>
        )}
        <Pairs
          which={list}
          pairs={d[list]}
          errors={errors}
          touched={touched}
          mode={mode}
          onPatch={patchPair}
          onRemove={removePair}
          onTouch={touch}
          onSecret={onSecret}
          onAdd={() => {
            const p = newPair();
            flushSync(() => setD((prev) => ({ ...prev, [list]: [...prev[list], p] })));
            document.getElementById(`field-mcp-${list}-${p.id}-name`)?.focus();
          }}
        />
      </div>
    </FormDialog>
  );
}

const NOUN: Record<PairList, string> = { env: "env variable", headers: "header" };
const GROUP: Record<PairList, string> = { env: "Env variables", headers: "Headers" };
const ADD: Record<PairList, string> = { env: "Add variable", headers: "Add header" };

function Pairs({
  which,
  pairs,
  errors,
  touched,
  mode,
  onPatch,
  onRemove,
  onTouch,
  onSecret,
  onAdd,
}: {
  which: PairList;
  pairs: readonly Pair[];
  errors: ReadonlyMap<number, string>;
  touched: ReadonlySet<number> | "all";
  mode: ConfigMode;
  onPatch: (which: PairList, id: number, patch: Partial<Pair>) => void;
  onRemove: (which: PairList, id: number) => void;
  onTouch: (id: number) => void;
  onSecret: (name: string) => boolean;
  onAdd: () => void;
}) {
  const groupId = useId();
  const rowsEl = useRef<HTMLDivElement>(null);
  const addEl = useRef<HTMLButtonElement>(null);
  // Stable, so the memoised rows skip a render when another row changes. After the commit the next row sits at the
  // removed one's index: focus its name, else the previous row's, else "Add".
  const remove = useCallback(
    (id: number, index: number) => {
      flushSync(() => onRemove(which, id));
      const rows = rowsEl.current?.children;
      const row = rows?.[index] ?? rows?.[index - 1];
      (row?.querySelector("input") ?? addEl.current)?.focus();
    },
    [onRemove, which],
  );
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="mb-1.5 text-[0.8125rem] font-medium">{GROUP[which]}</legend>
      <div ref={rowsEl} className="grid gap-3">
        {pairs.map((p, i) => (
          <PairRow
            key={p.id}
            which={which}
            pair={p}
            index={i}
            error={touched === "all" || touched.has(p.id) ? errors.get(p.id) : undefined}
            mode={mode}
            onPatch={onPatch}
            onRemove={remove}
            onTouch={onTouch}
            onSecret={onSecret}
          />
        ))}
      </div>
      <Button
        ref={addEl}
        id={`${groupId}-add`}
        type="button"
        variant="ghost"
        size="sm"
        className="justify-self-start"
        onClick={onAdd}
      >
        <Plus aria-hidden="true" />
        {ADD[which]}
      </Button>
    </fieldset>
  );
}

/** One env or header row: name and value side by side from `md`, stacked below it. */
const PairRow = memo(function PairRow({
  which,
  pair,
  index,
  error,
  mode,
  onPatch,
  onRemove,
  onTouch,
  onSecret,
}: {
  which: PairList;
  pair: Pair;
  index: number;
  error?: string;
  mode: ConfigMode;
  onPatch: (which: PairList, id: number, patch: Partial<Pair>) => void;
  onRemove: (id: number, index: number) => void;
  onTouch: (id: number) => void;
  onSecret: (name: string) => boolean;
}) {
  const caret = useRef<Caret | null>(null);
  const valueEl = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string>();
  const n = `${NOUN[which]} ${index + 1}`;
  const base = `mcp-${which}-${pair.id}`;

  const onPick = (name: string, fromSheet: boolean) => {
    const r = insertReference(pair.value, name, caret.current);
    flushSync(() => onPatch(which, pair.id, { value: r.value }));
    caret.current = { start: r.at, end: r.at };
    if (onSecret(name)) setNote(secretAddedNote(name, mode));
    const el = valueEl.current;
    el?.setSelectionRange(r.at, r.at);
    // From the sheet: its close hands focus back here, after the value rendered.
    if (fromSheet) returnFocusAfterChild(() => valueEl.current);
    else el?.focus();
  };

  return (
    <div className="grid min-w-0 gap-2 @lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] @lg:items-start">
      <FieldShell name={`${base}-name`} label="Name" error={error}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            value={pair.name}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-label={`Name, ${n}`}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            onChange={(e) => onPatch(which, pair.id, { name: e.target.value })}
            onBlur={() => onTouch(pair.id)}
          />
        )}
      </FieldShell>
      <FieldShell
        name={`${base}-value`}
        label="Value"
        help={note}
        action={<InsertSecret label={`${CONFIG_COPY.insertSecret}, ${n}`} onPick={onPick} />}
      >
        {({ id, describedBy }) => (
          <Input
            ref={valueEl}
            id={id}
            value={pair.value}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-label={`Value, ${n}`}
            aria-describedby={describedBy}
            onChange={(e) => onPatch(which, pair.id, { value: e.target.value })}
            onBlur={(e) => {
              caret.current = {
                start: e.target.selectionStart ?? e.target.value.length,
                end: e.target.selectionEnd ?? e.target.value.length,
              };
            }}
          />
        )}
      </FieldShell>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="justify-self-end @lg:mt-8"
        aria-label={`Remove ${n}`}
        onClick={() => onRemove(pair.id, index)}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
});
