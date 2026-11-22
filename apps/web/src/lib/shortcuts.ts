import { useEffect, useRef } from "react";
import { readPref, watchPrefs } from "./prefs";

/** "off" turns every single-key shortcut off (the shortcuts sheet's switch). */
export const SINGLE_KEYS_PREF = "of-single-keys";
const SEQUENCE_MS = 1000;

/** Whether a binding still fires behind the open modal it is given (by default none does). */
type AllowInModal = (modal: Element) => boolean;
type Entry = { run: (e: KeyboardEvent) => void; allowInModal?: AllowInModal };
/** Per key, a stack of registrations: the last added wins. */
const registry = new Map<string, Entry[]>();

const IGNORED_TARGETS =
  "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=menu],[role=menubar],[role=listbox],[role=tree],[role=grid],[role=radiogroup],[role=combobox],[role=textbox]";
/** Radix's modal Dialog renders `role="dialog"` without `aria-modal`. Non-modal layers (a peek
 *  sheet marks `data-modal="false"`, a popover is `popover-content`) leave the page usable. */
export const MODAL_SELECTOR =
  '[aria-modal="true"],[role="alertdialog"],[role="dialog"][data-state="open"]:not([data-modal="false"]):not([data-slot="popover-content"])';
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

/** True when a key press must not trigger a shortcut: modifiers, IME, already handled, typing or
 *  navigating inside a field, menu, listbox or tree, a modal open, or the off switch. */
export function shouldIgnore(e: KeyboardEvent): boolean {
  return ignoredPress(e) || openModals(e).length > 0;
}

/** Every reason to ignore a press except an open modal. */
function ignoredPress(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.isComposing || e.keyCode === 229 || e.defaultPrevented)
    return true;
  // Alt (Option) is fine when it produced a symbol such as `]`; Alt+letter is a browser/OS chord.
  if (e.altKey && /^[a-z0-9]$/i.test(e.key)) return true;
  if (readPref(SINGLE_KEYS_PREF) === "off") return true;
  const target = e.target instanceof Element ? e.target : null;
  return target?.closest(IGNORED_TARGETS) != null;
}

function openModals(e: KeyboardEvent): Element[] {
  const doc = e.target instanceof Element ? e.target.ownerDocument : document;
  return [...doc.querySelectorAll(MODAL_SELECTOR)];
}

function hasSequenceStartingWith(first: string): boolean {
  for (const [key, stack] of registry)
    if (stack.length > 0 && key.startsWith(`${first} `)) return true;
  return false;
}

function fire(key: string, e: KeyboardEvent, modals: Element[] = []): boolean {
  const stack = registry.get(key);
  const top = stack?.[stack.length - 1];
  if (!top) return false;
  const allow = top.allowInModal;
  if (modals.length > 0 && !(allow && modals.every(allow))) return false;
  e.preventDefault();
  top.run(e);
  return true;
}

/** One `keydown` listener for the page; returns its remover. */
export function installShortcuts(win: Window = window): () => void {
  let pending: { key: string; at: number } | null = null;
  const release = watchPrefs();
  const onKeyDown = (e: KeyboardEvent) => {
    // A held key and a bare modifier neither fire nor disturb a sequence in progress.
    if (e.repeat || MODIFIER_KEYS.has(e.key)) return;
    if (ignoredPress(e)) {
      pending = null;
      return;
    }
    // Option+] on a US Mac types a symbol, not `]`: the physical key stands in.
    const key = e.altKey && e.code === "BracketRight" ? "]" : e.key;
    // Behind a modal only a binding that allows every open one fires, and no sequence starts.
    const modals = openModals(e);
    if (modals.length > 0) {
      pending = null;
      fire(key, e, modals);
      return;
    }
    const now = Date.now();
    const first = pending && now - pending.at <= SEQUENCE_MS ? pending.key : null;
    pending = null;
    if (first && fire(`${first} ${key}`, e)) return;
    if (hasSequenceStartingWith(key)) pending = { key, at: now };
    fire(key, e);
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
 * `allowInModal` lets it fire behind an open modal it accepts (the panel toggle behind its own
 * drawer); every other binding is blocked while a modal is open.
 */
export function useShortcut(
  key: string,
  handler: (e: KeyboardEvent) => void,
  opts: { enabled?: boolean; allowInModal?: AllowInModal } = {},
): void {
  const enabled = opts.enabled ?? true;
  const latest = useRef(handler);
  latest.current = handler;
  const allow = useRef(opts.allowInModal);
  allow.current = opts.allowInModal;
  useEffect(() => {
    if (!enabled) return;
    const entry: Entry = {
      run: (e) => latest.current(e),
      allowInModal: (m) => allow.current?.(m) ?? false,
    };
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
