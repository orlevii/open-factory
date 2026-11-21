import { useEffect, useRef } from "react";
import { readPref, watchPrefs } from "./prefs";

/** "off" turns every single-key shortcut off (the shortcuts sheet's switch). */
export const SINGLE_KEYS_PREF = "of-single-keys";
const SEQUENCE_MS = 1000;

type Entry = { run: (e: KeyboardEvent) => void };
/** Per key, a stack of registrations: the last added wins. */
const registry = new Map<string, Entry[]>();

const IGNORED_TARGETS =
  "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=menu],[role=menubar],[role=listbox],[role=tree],[role=combobox],[role=textbox]";
const MODAL = '[aria-modal="true"],[role="alertdialog"]';

/** True when a key press must not trigger a shortcut: modifiers, IME, already handled, typing or
 *  navigating inside a field, menu, listbox or tree, a modal open, or the off switch. */
export function shouldIgnore(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.isComposing || e.defaultPrevented) return true;
  // Alt (Option) is fine when it produced a symbol such as `]`; Alt+letter is a browser/OS chord.
  if (e.altKey && /^[a-z0-9]$/i.test(e.key)) return true;
  if (readPref(SINGLE_KEYS_PREF) === "off") return true;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(IGNORED_TARGETS)) return true;
  const doc = target?.ownerDocument ?? document;
  return doc.querySelector(MODAL) !== null;
}

function hasSequenceStartingWith(first: string): boolean {
  for (const [key, stack] of registry)
    if (stack.length > 0 && key.startsWith(`${first} `)) return true;
  return false;
}

function fire(key: string, e: KeyboardEvent): boolean {
  const stack = registry.get(key);
  const top = stack?.[stack.length - 1];
  if (!top) return false;
  e.preventDefault();
  top.run(e);
  return true;
}

/** One `keydown` listener for the page; returns its remover. */
export function installShortcuts(win: Window = window): () => void {
  let pending: { key: string; at: number } | null = null;
  const release = watchPrefs();
  const onKeyDown = (e: KeyboardEvent) => {
    if (shouldIgnore(e)) return;
    const now = Date.now();
    const first = pending && now - pending.at <= SEQUENCE_MS ? pending.key : null;
    pending = null;
    if (first && fire(`${first} ${e.key}`, e)) return;
    if (hasSequenceStartingWith(e.key)) pending = { key: e.key, at: now };
    fire(e.key, e);
  };
  win.addEventListener("keydown", onKeyDown as EventListener);
  return () => {
    win.removeEventListener("keydown", onKeyDown as EventListener);
    release();
  };
}

/**
 * Binds a key (a single character, or a `"g i"` sequence) while mounted and enabled. It registers
 * once per `(key, enabled)`; the latest handler is read through a ref, so a re-render never
 * re-registers or reorders the stack. The most recently registered binding for a key wins.
 */
export function useShortcut(
  key: string,
  handler: (e: KeyboardEvent) => void,
  opts: { enabled?: boolean } = {},
): void {
  const enabled = opts.enabled ?? true;
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const entry: Entry = { run: (e) => latest.current(e) };
    const stack = registry.get(key) ?? [];
    stack.push(entry);
    registry.set(key, stack);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0 && registry.get(key) === stack) registry.delete(key);
    };
  }, [key, enabled]);
}
