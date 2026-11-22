/** Escape `\`, `%` and `_` so user text matches literally in a LIKE/ILIKE pattern (use with `escape '\'`). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}
