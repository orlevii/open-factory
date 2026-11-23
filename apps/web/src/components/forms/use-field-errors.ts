import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { focusField } from "./focus-field";

export type Checks<F extends string> = Partial<Record<F, () => string | undefined>>;
export type FieldErrors<F extends string> = {
  errors: Partial<Record<F, string>>;
  /** Bumped by every focus request: a failing submit(), a server() that mapped a field, set(..., { focus: true }). */
  attempt: number;
  change(f: F): void;
  blur(f: F, e?: { relatedTarget: EventTarget | null }): void;
  /** Callers guard async staleness (compare the looked-up value to the current value before calling). Safe in handlers and effects. A call during render schedules another render even when nothing changes, so the caller must guard it: `if (msg && f.errors.field !== msg) f.set(...)`. */
  set(f: F, message: string | undefined, opts?: { focus?: boolean }): void;
  server(fields: Record<string, string> | undefined): boolean;
  /** Checks run against the last committed values. `extra`: async results from this same tick (a dependency lookup); they count as external errors for this submit. */
  submit(fields?: readonly F[], extra?: Partial<Record<F, string | undefined>>): boolean;
  reset(): void;
};

// WebKit doesn't focus a clicked button, so a blur toward one has no relatedTarget: fall back to the last pointerdown.
// Installed once, on the first hook mount (a module flag checked in the hook's layout effect), not as an import side effect.
let lastPointer: { target: EventTarget | null; at: number } = { target: null, at: 0 };
let tracking = false;
function trackPointerOnce() {
  if (tracking) return;
  tracking = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastPointer = { target: e.target, at: performance.now() };
    },
    { capture: true, passive: true },
  );
}
const skips = (t: EventTarget | null) =>
  t instanceof Element && t.closest("[data-skip-validate]") !== null;

type Ext<F extends string> = Partial<Record<F, string>>;

export function useFieldErrors<F extends string>({
  form,
  checks,
  fields,
}: {
  form: RefObject<HTMLElement | null>;
  checks: Checks<F>;
  /** Every field this form owns; `server` maps only these, `submit()` checks these. */
  fields: readonly F[];
}): FieldErrors<F> {
  useLayoutEffect(trackPointerOnce, []);
  const [flagged, setFlagged] = useState<ReadonlySet<F>>(() => new Set());
  const [external, setExternal] = useState<Ext<F>>({});
  const changed = useRef(new Set<F>());
  // One counter for focus requests and disclosures (§6.5): the layout effect keys on it.
  const [attempt, setAttempt] = useState(0);
  // Last-committed mirrors for event handlers. They are updated in a layout effect, never during render: handlers run
  // after commit, and useEffectEvent can't be called from event handlers, so a plain ref updated here is the pattern.
  const checksRef = useRef(checks);
  const externalRef = useRef(external);
  const flaggedRef = useRef(flagged);
  useLayoutEffect(() => {
    checksRef.current = checks;
    externalRef.current = external;
    flaggedRef.current = flagged;
  });
  useLayoutEffect(() => {
    if (attempt > 0) focusField(form.current);
  }, [attempt, form]);

  // Render: a flagged field's message comes from its check now (D4); a passing flagged field is unflagged in this render.
  const errors: Ext<F> = {};
  const passed: F[] = [];
  for (const f of fields) {
    const own = flagged.has(f) ? checks[f]?.() : undefined;
    if (flagged.has(f) && !own) passed.push(f);
    const m = external[f] ?? own;
    if (m) errors[f] = m;
  }
  if (passed.length > 0)
    setFlagged((s) => {
      const n = new Set(s);
      for (const f of passed) n.delete(f);
      return n;
    });

  // Bail-out updater: returning the same object leaves the state untouched. It does not make a render-time call free, so callers guard those.
  const writeExternal = (f: F, m: string | undefined) =>
    setExternal((s) => {
      if (s[f] === m) return s;
      const n = { ...s };
      if (m) n[f] = m;
      else delete n[f];
      return n;
    });

  return {
    errors,
    attempt,
    change(f) {
      changed.current.add(f);
      writeExternal(f, undefined);
    },
    blur(f, e) {
      if (!document.hasFocus()) return;
      const to =
        e?.relatedTarget ?? (performance.now() - lastPointer.at < 500 ? lastPointer.target : null);
      if (skips(to)) return;
      if (!changed.current.has(f) && !flaggedRef.current.has(f) && !externalRef.current[f]) return;
      if (checksRef.current[f]?.()) setFlagged((s) => (s.has(f) ? s : new Set(s).add(f)));
    },
    set(f, message, opts) {
      writeExternal(f, message);
      if (message && opts?.focus) setAttempt((n) => n + 1); // even when the message is unchanged
    },
    server(map) {
      const next: Ext<F> = {};
      for (const f of fields) if (map?.[f]) next[f] = map[f];
      if (Object.keys(next).length === 0) return false;
      setExternal(next);
      setAttempt((n) => n + 1);
      return true;
    },
    submit(only = fields, extra = {}) {
      const failing = only.filter((f) => checksRef.current[f]?.());
      const ext: Ext<F> = {};
      for (const f of only) {
        const m = f in extra ? extra[f] : externalRef.current[f];
        if (m) ext[f] = m;
      }
      setFlagged(new Set(failing));
      setExternal(ext);
      if (failing.length > 0 || Object.keys(ext).length > 0) {
        setAttempt((n) => n + 1);
        return false;
      }
      return true;
    },
    reset() {
      setFlagged(new Set());
      setExternal({});
      changed.current.clear();
    },
  };
}
