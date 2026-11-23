import { type ReactNode, useCallback, useMemo } from "react";
import { type AddSlot, ConfigList, type RowNote } from "./config-list";
import { type ConfigField, FIELD_PATHS } from "./fields";
import { useConfigScope, useFieldNote } from "./scope";
import { WrongType } from "./section";
import { readAt, readList } from "./tolerant";

/** The list fields: each binds one union list of the draft to a `ConfigList`. */
export type ListFieldId = Extract<
  ConfigField,
  "skills" | "plugins" | "allow" | "deny" | "trustNotes" | "envSecrets" | "canSpawn"
>;

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const NO_ROWS: ReadonlyMap<number, RowNote> = new Map();
const INDEX = /^\d+$/;

/**
 * A list field of the form (spec §12.2). Agent mode shows the template's items read-only in their own group and this
 * agent's items (the overlay's) as editable rows; template mode shows the template's as editable rows. A value that
 * isn't a list of strings reads "Edit this in Raw JSON.". Issues on an item (`settings.permissions.allow.3`) show
 * under that row.
 */
export function ListField({
  field,
  label,
  noun,
  mono,
  help,
  placeholder,
  check,
  rowCheck,
  renderAdd,
  lead,
  format,
}: {
  field: ListFieldId;
  label: string;
  noun: string;
  mono?: boolean;
  help?: string;
  placeholder?: string;
  check?: (value: string) => string | undefined;
  /** A client rule for rows already in the list (a name Raw JSON added): a failing row gets an error note. Stable. */
  rowCheck?: (value: string) => string | undefined;
  renderAdd?: (a: AddSlot) => ReactNode;
  lead?: ReactNode;
  format?: (value: string) => ReactNode;
}) {
  const s = useConfigScope();
  const note = useFieldNote(field);
  const path = FIELD_PATHS[field];
  const { update, fieldErrors } = s;

  const onAdd = useCallback(
    (v: string) => update(path, (prev) => [...asList(prev), v]),
    [update, path],
  );
  const onRemove = useCallback(
    (i: number) => update(path, (prev) => asList(prev).filter((_, j) => j !== i)),
    [update, path],
  );

  const own = readList(readAt(s.value, path));
  const ownItems = own.ok ? own.items : null;
  const items = s.byField.get(field)?.items;
  const rowNotes = useMemo(() => {
    const m = new Map<number, RowNote>();
    if (items) for (const [k, note] of items) if (INDEX.test(k)) m.set(Number(k), note);
    // A client rule's error wins over a server note on the same row: it is about the value as it is now.
    if (rowCheck && ownItems)
      ownItems.forEach((v, i) => {
        const message = rowCheck(v);
        if (message) m.set(i, { message, severity: "error" });
      });
    return m.size === 0 ? NO_ROWS : m;
  }, [items, rowCheck, ownItems]);

  if (!own.ok) return <WrongType field={field} label={label} />;
  // A broken template has no base: its rows can't be shown, so there is no template group.
  const tpl = s.base ? readList(readAt(s.base, path)) : null;
  const inherited = tpl ? (tpl.ok ? tpl.items : []) : undefined;

  return (
    <ConfigList
      name={field}
      label={label}
      noun={noun}
      mono={mono}
      help={help}
      placeholder={placeholder}
      check={check}
      own={own.items}
      inherited={inherited}
      inheritedLabel={s.inheritedLabel}
      readOnly={s.readOnly}
      error={note.error}
      warning={note.warning}
      rowNotes={rowNotes}
      onAdd={onAdd}
      onRemove={onRemove}
      onReject={(m) => fieldErrors.set(field, m)}
      onInput={() => fieldErrors.change(field)}
      renderAdd={renderAdd}
      lead={lead}
      format={format}
    />
  );
}
