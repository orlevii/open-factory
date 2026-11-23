const FOCUSABLE =
  "input:not([type=hidden]),textarea,select,button,[role=combobox],[tabindex]:not([tabindex='-1'])";
/** Focus the first invalid field in DOM order and bring the whole field, note included, into view (spec §5.4, D6). */
export function focusField(root: HTMLElement | null) {
  if (!root) return;
  const el = [...root.querySelectorAll<HTMLElement>('[aria-invalid="true"]')].find(
    (e) => !e.closest("fieldset:disabled"),
  );
  if (!el) return;
  const target = el instanceof HTMLFieldSetElement ? el.querySelector<HTMLElement>(FOCUSABLE) : el;
  target?.focus({ preventScroll: true });
  (el.closest("[data-field]") ?? el).scrollIntoView?.({ block: "nearest" });
}
