import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Durable composer drafts (U3 §13.2, review note m6): `localStorage` under versioned keys, stored as
 * `{ text, at }` and dropped after 7 days. A tab writes only while its box is focused (throttled, flushed
 * on blur, pagehide and unmount) or when the app itself puts text in the box (`persist`); an unfocused
 * tab adopts another tab's write only when its own text is the value that write replaced, so it never
 * wipes what it typed itself and never resurrects sent text.
 */
const PREFIX = "of-draft:v1:";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const THROTTLE_MS = 150;

export const agentDraftKey = (slug: string) => `agent:${slug}`;
export const taskDraftKey = (taskKey: string) => `task:${taskKey}`;

/** The text of a stored value, or "" when it is absent, unreadable or expired. */
function textOf(raw: string | null | undefined): { text: string; expired: boolean } {
  if (!raw) return { text: "", expired: false };
  try {
    const v = JSON.parse(raw) as { text?: unknown; at?: unknown };
    if (typeof v.text !== "string" || typeof v.at !== "number") return { text: "", expired: true };
    if (Date.now() - v.at > TTL_MS) return { text: "", expired: true };
    return { text: v.text, expired: false };
  } catch {
    return { text: "", expired: true };
  }
}

export function readDraft(key: string): string {
  try {
    const { text, expired } = textOf(localStorage.getItem(PREFIX + key));
    if (expired) localStorage.removeItem(PREFIX + key);
    return text;
  } catch {
    return ""; // private mode
  }
}

export function writeDraft(key: string, text: string): void {
  try {
    if (text.trim() === "") localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify({ text, at: Date.now() }));
  } catch {
    /* private mode, or full */
  }
}

/** A send whose POST aborted (U3 §13.2): its `clientMessageId` and text, kept beside the draft so a remount
 *  resends the unchanged text under the same id (the server dedupes it if the original landed). */
export type UnconfirmedSend = { id: string; sent: string };
const UNCONFIRMED_SUFFIX = ":unconfirmed";

export function readUnconfirmed(key: string): UnconfirmedSend | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key + UNCONFIRMED_SUFFIX);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { id?: unknown; sent?: unknown; at?: unknown };
    if (typeof v.id === "string" && typeof v.sent === "string" && typeof v.at === "number")
      if (Date.now() - v.at <= TTL_MS) return { id: v.id, sent: v.sent };
    localStorage.removeItem(PREFIX + key + UNCONFIRMED_SUFFIX);
  } catch {
    /* private mode, or unreadable */
  }
  return undefined;
}

export function writeUnconfirmed(key: string, u: UnconfirmedSend | undefined): void {
  try {
    if (!u) localStorage.removeItem(PREFIX + key + UNCONFIRMED_SUFFIX);
    else
      localStorage.setItem(
        PREFIX + key + UNCONFIRMED_SUFFIX,
        JSON.stringify({ id: u.id, sent: u.sent, at: Date.now() }),
      );
  } catch {
    /* private mode, or full */
  }
}

/** Removes `sent` from the stored draft and nothing else: other text (typed since, or by another tab)
 *  stays. Runs focused or not: it is what the server accepted. */
function clearSentDraft(key: string, sent: string): void {
  const stored = readDraft(key);
  if (!sent || !stored) return;
  if (stored === sent) writeDraft(key, "");
  else if (stored.startsWith(`${sent}\n`)) writeDraft(key, stored.slice(sent.length + 1));
  else if (stored.endsWith(`\n${sent}`)) writeDraft(key, stored.slice(0, -sent.length - 1));
}

const joined = (parts: string[]) => parts.filter((p) => p.trim() !== "").join("\n");

export interface DraftHandle {
  /** The server accepted `sent`: it leaves the stored draft (and the in-flight list). */
  clearSent(sent: string): void;
  /** A send left the box: the stored draft keeps `sent` until `clearSent` or `release`. */
  hold(sent: string): void;
  /** The send failed: `sent` is no longer held (the caller puts it back in the box). */
  release(sent: string): void;
  /** The app (not the user) changed the box (a Cancel put-back, a failed send's text): write it now,
   *  focused or not, so a reload keeps it. */
  persist(): void;
  /** Spread on the textarea: writes happen only while it is focused. */
  bind: { onFocus(): void; onBlur(): void };
}

type SetText = (v: string | ((cur: string) => string)) => void;

export function useDraft(key: string): [string, SetText, DraftHandle] {
  const [text, setState] = useState(() => readDraft(key));
  const [shownKey, setShownKey] = useState(key);
  // The box as last set (state may not have committed yet), and the sends still in flight.
  const textRef = useRef(text);
  const held = useRef<string[]>([]);
  const focused = useRef(false);
  const pending = useRef<{ key: string; text: string } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyRef = useRef(key);
  if (shownKey !== key) {
    // Another agent or task: its own draft (the old key's pending write is flushed below).
    const next = readDraft(key);
    setShownKey(key);
    setState(next);
    textRef.current = next;
    held.current = [];
  }

  const flush = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const p = pending.current;
    pending.current = undefined;
    if (p) writeDraft(p.key, p.text);
  }, []);

  const schedule = useCallback(() => {
    if (!focused.current) return;
    pending.current = { key: keyRef.current, text: joined([...held.current, textRef.current]) };
    timer.current ??= setTimeout(flush, THROTTLE_MS);
  }, [flush]);

  const setText = useCallback<SetText>(
    (v) => {
      const next = typeof v === "function" ? v(textRef.current) : v;
      if (next === textRef.current) return;
      textRef.current = next;
      setState(next);
      schedule();
    },
    [schedule],
  );

  useEffect(() => {
    keyRef.current = key;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== PREFIX + key || focused.current) return;
      const mine = joined([...held.current, textRef.current]);
      if (mine !== textOf(e.oldValue).text) return;
      const next = textOf(e.newValue).text;
      textRef.current = next;
      held.current = [];
      setState(next);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [key, flush]);

  const handle = useMemo<DraftHandle>(
    () => ({
      clearSent(sent) {
        held.current = without(held.current, sent);
        flush();
        clearSentDraft(keyRef.current, sent);
      },
      hold(sent) {
        held.current = [...held.current, sent];
      },
      release(sent) {
        held.current = without(held.current, sent);
      },
      persist() {
        pending.current = { key: keyRef.current, text: joined([...held.current, textRef.current]) };
        flush();
      },
      bind: {
        onFocus() {
          focused.current = true;
        },
        onBlur() {
          focused.current = false;
          flush();
        },
      },
    }),
    [flush],
  );

  return [text, setText, handle];
}

function without(list: string[], s: string): string[] {
  const i = list.indexOf(s);
  return i === -1 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
}
