/**
 * The timeline row a control belongs to. A row's own content sits inside its `[data-row]` element;
 * a tool call's body is that row's sibling, marked `[data-row-body="<key>"]`, so a control there
 * resolves through the marker to its row. The nearer of the two wins, so a row nested in a body
 * (a subagent's text) is its own owner.
 */
export function rowOf(el: Element | null | undefined): HTMLElement | null {
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-row]");
  const body = el.closest<HTMLElement>("[data-row-body]");
  if (!body || (row && body.contains(row))) return row;
  return bodyRow(body);
}

/** The row a body marker belongs to: its sibling `[data-row]` with the same key. */
export function bodyRow(body: HTMLElement): HTMLElement | null {
  const key = CSS.escape(body.dataset.rowBody ?? "");
  return body.parentElement?.querySelector<HTMLElement>(`:scope > [data-row="${key}"]`) ?? null;
}
