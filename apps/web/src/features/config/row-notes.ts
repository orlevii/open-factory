import type { RowNote } from "./config-list";

/** An error replaces a warning; otherwise the first note wins. */
export const worse = (had: RowNote | undefined, next: RowNote): RowNote =>
  !had || (had.severity === "warning" && next.severity === "error") ? next : had;

/**
 * A field's item notes placed on its rendered rows. `place` names the row a key belongs to, or undefined when no row
 * is rendered for it (an unknown server, an index past the list). Those notes aren't dropped: the worst one comes
 * back as `rest`, for the field's own note, so every issue a field owns shows somewhere (lead addendum, review I1).
 */
export function placeNotes<K>(
  items: ReadonlyMap<string, RowNote> | undefined,
  place: (key: string) => K | undefined,
): { rows: Map<K, RowNote>; rest?: RowNote } {
  const rows = new Map<K, RowNote>();
  let rest: RowNote | undefined;
  if (items)
    for (const [key, note] of items) {
      const at = place(key);
      if (at === undefined) rest = worse(rest, note);
      else rows.set(at, worse(rows.get(at), note));
    }
  return rest ? { rows, rest } : { rows };
}

/** The field's note with an unplaced item note folded in, severity kept. The field's own note goes first. */
export function withRest(
  note: { error?: string; warning?: string },
  rest: RowNote | undefined,
): { error?: string; warning?: string } {
  if (!rest) return note;
  return rest.severity === "error"
    ? { error: note.error ?? rest.message, warning: note.warning }
    : { error: note.error, warning: note.warning ?? rest.message };
}

/** The entry a dotted item key belongs to: the longest name that is the key or a prefix of it at a dot. */
export function entryFor(key: string, namesLongestFirst: readonly string[]): string | undefined {
  return namesLongestFirst.find((n) => key === n || key.startsWith(`${n}.`));
}
