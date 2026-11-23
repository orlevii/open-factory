import { X } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IssueIcon } from "@/features/templates/issue-list";
import { cn } from "@/lib/utils";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";

/** Only the template group collapses, and only past this many rows (spec §12.2). */
export const COLLAPSE_AT = 8;

type Props = {
  /** The field id: the add input is `field-<name>`. */
  name: string;
  label: string;
  /** "allow rule": the remove label reads "Remove allow rule 3". */
  noun: string;
  /** The editable rows: this agent's (agent mode) or the template's (template mode). */
  own: readonly string[];
  /** Agent mode: the template's rows, read-only, in their own group. Absent in template mode. */
  inherited?: readonly string[];
  /** "From template dev". */
  inheritedLabel?: string;
  /** Rules, names and commands are mono; prose (trust notes) is Geist. */
  mono?: boolean;
  readOnly?: boolean;
  help?: string;
  error?: string;
  warning?: string;
  /** Notes for single rows (a server issue on `…allow.3`), by index in `own`. */
  rowNotes?: ReadonlyMap<number, RowNote>;
  placeholder?: string;
  /** A rule for one new item (a plugin's `name@marketplace`); its message goes to `onReject`. */
  check?: (value: string) => string | undefined;
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  /** A refused add: a duplicate or a failed `check`. The caller shows the message in the field note. */
  onReject: (message: string) => void;
  /** The add input changed: the caller clears a refused-add note. */
  onInput: () => void;
  /** A picker in place of the add input (skills, secrets, templates): it calls `add` with the picked value. */
  renderAdd?: (a: AddSlot) => ReactNode;
  /** Read-only rows above the groups (a template's own skills). */
  lead?: ReactNode;
  /** A row's text from its value ("Available as $GH_TOKEN"). A stable function: rows are memoised. */
  format?: (value: string) => ReactNode;
};

/** What a custom add control gets: the field's id and note wiring, and the add that checks duplicates. */
export type AddSlot = {
  id: string;
  describedBy?: string;
  invalid: boolean;
  add: (value: string) => void;
};

export type RowNote = { message: string; severity: "error" | "warning" };

/** Row keys by value; a repeated value (only Raw JSON can make one) gets a counted key. */
function keysFor(prefix: string, values: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((v) => {
    const n = (seen.get(v) ?? 0) + 1;
    seen.set(v, n);
    return n === 1 ? `${prefix}${v}` : `${prefix}${v}#${n}`;
  });
}

const ROW =
  "flex min-h-8 items-start gap-2 rounded-md px-2 pointer-coarse:min-h-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px]";
const VALUE = "min-w-0 flex-1 py-1.5 text-sm [overflow-wrap:anywhere]";
const MONO = "font-mono text-[0.8125rem]";

const Row = memo(function Row({
  rowKey,
  value,
  index,
  noun,
  mono,
  note,
  format,
  register,
  onRemove,
}: {
  rowKey: string;
  value: string;
  index: number;
  noun: string;
  mono?: boolean;
  note?: RowNote;
  format?: (value: string) => ReactNode;
  register: (key: string, el: HTMLLIElement | null) => void;
  /** Absent on read-only rows (the template group, a read-only form): no remove button. */
  onRemove?: (index: number) => void;
}) {
  const noteId = useId();
  return (
    <li
      ref={(el) => {
        register(rowKey, el);
        return () => register(rowKey, null);
      }}
      // Template rows take programmatic focus after "Show all"; they are not tab stops.
      tabIndex={onRemove ? undefined : -1}
      className={ROW}
    >
      <div className="min-w-0 flex-1">
        <p className={cn(VALUE, mono && !format && MONO)}>{format ? format(value) : value}</p>
        {note ? (
          <p
            id={noteId}
            className={cn(
              "flex items-start gap-1.5 pb-1 text-[0.8125rem]",
              note.severity === "error" ? "text-destructive" : "text-foreground",
            )}
          >
            <IssueIcon severity={note.severity} />
            <span className="min-w-0 [overflow-wrap:anywhere]">{note.message}</span>
          </p>
        ) : null}
      </div>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-0.5"
          aria-label={`Remove ${noun} ${index + 1}`}
          aria-describedby={note ? noteId : undefined}
          onClick={() => onRemove(index)}
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
});

/** Every list on the Configuration form (spec §12.2): rules, notes, skills, plugins, secrets, spawnable templates. */
export function ConfigList({
  name,
  label,
  noun,
  own,
  inherited,
  inheritedLabel = "From template",
  mono,
  readOnly,
  help,
  error,
  warning,
  rowNotes,
  placeholder,
  check,
  onAdd,
  onRemove,
  onReject,
  onInput,
  renderAdd,
  lead,
  format,
}: Props) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const input = useRef<HTMLInputElement>(null);
  const ownListEl = useRef<HTMLUListElement>(null);
  const groupId = useId();

  const register = useCallback((key: string, el: HTMLLIElement | null) => {
    if (el) rows.current.set(key, el);
    else rows.current.delete(key);
  }, []);

  const ownKeys = useMemo(() => keysFor("o:", own), [own]);
  const tplKeys = useMemo(() => keysFor("t:", inherited ?? []), [inherited]);
  // Value → index, for duplicate checks in O(1) (L2).
  const ownSet = useMemo(() => new Set(own), [own]);
  const tplIndex = useMemo(
    () => new Map((inherited ?? []).map((v, i) => [v, i] as const)),
    [inherited],
  );

  const tplCount = inherited?.length ?? 0;
  const collapsible = tplCount > COLLAPSE_AT;
  const shownTpl =
    collapsible && !expanded ? (inherited ?? []).slice(0, COLLAPSE_AT) : (inherited ?? []);

  // Stable while `onRemove` is, so the memoised rows skip a render when the list changes around them.
  const remove = useCallback(
    (index: number) => {
      flushSync(() => onRemove(index));
      // After the commit, the next row sits at the removed row's index. Looked up by position, not key: a repeated
      // value's counted key (`o:a#2`) shifts when an earlier copy goes.
      const btn = ownListEl.current?.children[index]?.querySelector("button");
      (btn ?? input.current)?.focus();
    },
    [onRemove],
  );

  const commit = (raw: string): boolean => {
    const v = raw.trim();
    if (!v) return false;
    const at = tplIndex.get(v);
    if (ownSet.has(v) || at !== undefined) {
      onReject(CONFIG_FIELD_MSG.duplicate);
      if (at !== undefined && at >= COLLAPSE_AT && !expanded) flushSync(() => setExpanded(true));
      const key = at !== undefined ? `t:${v}` : `o:${v}`;
      rows.current.get(key)?.scrollIntoView({ block: "nearest" });
      return false;
    }
    const bad = check?.(v);
    if (bad) {
      onReject(bad);
      return false;
    }
    flushSync(() => onAdd(v));
    rows.current.get(`o:${v}`)?.scrollIntoView({ block: "nearest" });
    return true;
  };
  const add = () => {
    if (commit(text)) setText("");
  };

  const toggle = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    flushSync(() => setExpanded(true));
    const first = tplKeys[COLLAPSE_AT];
    if (first) rows.current.get(first)?.focus();
  };

  const ownList = (
    <ul ref={ownListEl} aria-labelledby={inherited ? `${groupId}-own` : undefined} className="grid">
      {own.map((v, i) => (
        <Row
          key={ownKeys[i]}
          rowKey={ownKeys[i] as string}
          value={v}
          index={i}
          noun={noun}
          mono={mono}
          note={rowNotes?.get(i)}
          format={format}
          register={register}
          onRemove={readOnly ? undefined : remove}
        />
      ))}
    </ul>
  );

  return (
    <FieldShell name={name} label={label} legend help={help} error={error} warning={warning}>
      {({ id, describedBy, invalid }) => (
        <div className="grid gap-2">
          {lead}
          {inherited ? (
            <div className="grid gap-1">
              <p id={`${groupId}-tpl`} className="text-[0.8125rem] text-muted-foreground">
                {inheritedLabel} · {tplCount}
              </p>
              <ul aria-labelledby={`${groupId}-tpl`} className="grid">
                {shownTpl.map((v, i) => (
                  <Row
                    key={tplKeys[i]}
                    rowKey={tplKeys[i] as string}
                    value={v}
                    index={i}
                    noun={noun}
                    mono={mono}
                    format={format}
                    register={register}
                  />
                ))}
              </ul>
              {collapsible ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-self-start"
                  aria-expanded={expanded}
                  onClick={toggle}
                >
                  {expanded ? CONFIG_COPY.showFewer : `Show all ${tplCount}`}
                </Button>
              ) : null}
            </div>
          ) : null}
          {inherited ? (
            <div className="grid gap-1">
              <p id={`${groupId}-own`} className="text-[0.8125rem] text-muted-foreground">
                {CONFIG_COPY.thisAgent} · {own.length}
              </p>
              {ownList}
            </div>
          ) : (
            ownList
          )}
          {readOnly ? null : renderAdd ? (
            renderAdd({ id, describedBy, invalid, add: commit })
          ) : (
            <div className="flex items-center gap-2">
              <Input
                ref={input}
                id={id}
                value={text}
                placeholder={placeholder}
                aria-label={`Add ${noun}`}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                className={cn(mono && "font-mono")}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setText(e.target.value);
                  onInput();
                }}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <Button type="button" variant="ghost" inForm onClick={add}>
                Add
              </Button>
            </div>
          )}
        </div>
      )}
    </FieldShell>
  );
}
