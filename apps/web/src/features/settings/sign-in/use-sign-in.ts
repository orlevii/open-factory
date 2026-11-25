import {
  ApiError,
  type AttemptView,
  attemptViewSchema,
  type CredentialSummary,
  MSG,
  type SignInState,
} from "@open-factory/shared";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { useOutcome } from "@/components/forms/form-outcome";
import type { FieldErrors } from "@/components/forms/use-field-errors";
import { inboxQueryKey } from "@/features/inbox/api";
import { credentialsQueryOptions } from "@/features/settings/api";
import { FORM_MSG } from "@/lib/form-messages";
import {
  cancelSignIn,
  isRetryableWaitError,
  signInQueryOptions,
  startSignIn,
  submitSignInCode,
  waitSignIn,
} from "./api";

export type Phase = "loading" | "idle" | "starting" | "ready" | "exchanging" | "verifying";
export type Line = { tone: "help" | "error"; text: string };
export type Result =
  | { ok: true; credential: CredentialSummary }
  | { ok: false; error: unknown }
  | { ok: "aborted" };

/** The Idle line (help text, not a message, spec §8.2). */
export const SIGN_IN_HELP =
  "Sign in with your Claude account in the browser, then paste the code shown.";
const HELP_LINE: Line = { tone: "help", text: SIGN_IN_HELP };
const OTHER_LINE: Line = { tone: "help", text: FORM_MSG.signInOtherPanel };
const UNAVAILABLE_LINE: Line = { tone: "help", text: MSG.signInUnavailable };
const KEY = signInQueryOptions.queryKey;
const ABORTED: Result = { ok: "aborted" };
/** Backoff between waits (spec §8.3): 1 s, 2 s, then 5 s, capped. */
const BACKOFF_MS = [1000, 2000, 5000] as const;

const PAST_CODE: ReadonlySet<SignInState> = new Set([
  "submitting",
  "exchanging",
  "verifying",
  "settled",
]);
const PHASE_OF: Record<SignInState, Phase> = {
  // Found on a GET (a reload during Start, or a Start in another tab): nothing here would ever move it on, so Idle.
  starting: "idle",
  awaiting_code: "ready",
  submitting: "exchanging",
  exchanging: "exchanging",
  verifying: "verifying",
  settled: "idle",
};
/** Refusals that leave the attempt as it was: the form's outcome line, never the panel's (spec §8.2). */
const NOT_ENDING: ReadonlySet<string> = new Set([
  "sign_in_busy",
  "sign_in_start_failed",
  "sign_in_state",
]);

// Per tab, outside React: survives unmount, StrictMode and a second panel; cleared on sign-out (resetSignIn).
/** Attempt ids this tab submitted (H1): only they may render a settled success. */
const submittedHere = new Set<string>();
/** One wait loop per attempt id (H2). */
const inFlight = new Map<string, { promise: Promise<Result>; controller: AbortController }>();
/** Bumped by resetSignIn(): a submit in flight across a sign-out must not start a wait loop afterwards. */
let generation = 0;

/**
 * Writes an attempt into the sign-in query. Only GET and POST start carry `url` (and the 409 extra may omit the
 * deadline), so a known url and deadline for the same attempt id are kept.
 */
function writeAttempt(qc: QueryClient, next: AttemptView | null) {
  qc.setQueryData(KEY, (old) => {
    const prev = old?.attempt;
    let attempt = next;
    if (next && prev && prev.attemptId === next.attemptId) {
      attempt = { ...next };
      if (next.url === undefined && prev.url !== undefined) attempt.url = prev.url;
      if (next.codeDeadline === undefined && prev.codeDeadline !== undefined)
        attempt.codeDeadline = prev.codeDeadline;
    }
    return { available: old?.available ?? true, attempt };
  });
}

/** Replaces the attempt with this id, leaving another id (a newer Start) alone. */
function patchAttempt(
  qc: QueryClient,
  attemptId: string,
  f: (a: AttemptView) => AttemptView | null,
) {
  qc.setQueryData(KEY, (old) =>
    old?.attempt?.attemptId === attemptId ? { ...old, attempt: f(old.attempt) } : old,
  );
}

/** The 409 `sign_in_state` extra: the attempt is still waiting for its code (the code never arrived). */
function attemptOf(e: unknown): AttemptView | undefined {
  if (!(e instanceof ApiError) || e.code !== "sign_in_state") return undefined;
  const r = attemptViewSchema.safeParse(e.body.attempt);
  return r.success ? r.data : undefined;
}

const isFieldError = (e: unknown) =>
  e instanceof ApiError && (e.code === "validation_error" || e.code === "credential_exists");

/**
 * The outcome's tab-wide side effects (H1), mounted or not: the query cache and the invalidations. A final answer
 * leaves the attempt `settled` in the cache, as the server holds it for 60 s, so a panel that mounts later joins the
 * wait once and renders it; the panel that renders it clears it.
 */
function finish(qc: QueryClient, attemptId: string, r: Result): Result {
  if (r.ok === "aborted") return r;
  if (r.ok) {
    patchAttempt(qc, attemptId, (a) => ({ ...a, state: "settled" }));
    void qc.invalidateQueries({ queryKey: credentialsQueryOptions.queryKey });
    void qc.invalidateQueries({ queryKey: inboxQueryKey });
    return r;
  }
  const back = attemptOf(r.error);
  if (back) writeAttempt(qc, back);
  else if (isFieldError(r.error)) {
    // Name or code refused before the code was written: the attempt is still awaiting its code.
  } else if (r.error instanceof ApiError && NOT_ENDING.has(r.error.code))
    void qc.invalidateQueries({ queryKey: KEY });
  else patchAttempt(qc, attemptId, (a) => ({ ...a, state: "settled" }));
  return r;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * The tab's one wait loop for an attempt (spec §8.3): `/code/wait` until a final answer; on a 202 or a retryable
 * error it waits 1 s, 2 s, then 5 s and asks again. It belongs to the tab, not to a panel: unmounting never aborts
 * it; it ends at a final answer, at Cancel, or at resetSignIn().
 */
export function waitUntilDone(qc: QueryClient, attemptId: string): Promise<Result> {
  const running = inFlight.get(attemptId);
  if (running) return running.promise;
  const controller = new AbortController();
  const { signal } = controller;
  const promise = (async (): Promise<Result> => {
    for (let n = 0; ; n++) {
      try {
        const r = await waitSignIn(attemptId, signal);
        if (signal.aborted) return ABORTED;
        if (r.kind === "done") return finish(qc, attemptId, { ok: true, credential: r.credential });
        writeAttempt(qc, r.attempt);
      } catch (e) {
        if (signal.aborted) return ABORTED;
        if (!isRetryableWaitError(e)) return finish(qc, attemptId, { ok: false, error: e });
      }
      await sleep(BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)] ?? 5000, signal);
      if (signal.aborted) return ABORTED;
    }
  })();
  const entry = { promise, controller };
  inFlight.set(attemptId, entry);
  void promise.finally(() => {
    if (inFlight.get(attemptId) === entry) inFlight.delete(attemptId);
  });
  return promise;
}

/** Sign-out (R3): aborts every wait loop and forgets what this tab submitted, so the next user inherits nothing. */
export function resetSignIn() {
  generation++;
  for (const { controller } of inFlight.values()) controller.abort();
  inFlight.clear();
  submittedHere.clear();
}

/**
 * Settings' inline Cancel (D13): ends this tab's `create` attempt while it still waits for its code. One past the
 * code can't be cancelled (the server refuses); its wait loop delivers the outcome.
 */
export async function cancelCreateAttempt(qc: QueryClient) {
  const a = qc.getQueryData(KEY)?.attempt;
  if (a?.purpose !== "create" || (a.state !== "starting" && a.state !== "awaiting_code")) return;
  try {
    await cancelSignIn(a.attemptId);
    patchAttempt(qc, a.attemptId, () => null);
  } catch {
    void qc.invalidateQueries({ queryKey: KEY });
  }
}

/** What the panel last showed: the attempt id, its last deadline, whether it was past the code, and its line. */
type Shown = { id?: string; deadline?: string; past?: boolean; line?: Line };

/**
 * The line for an attempt that vanished, or was replaced, without a local action (spec §8.3). One that was past the
 * code ends through the wait loop, never with a line here.
 */
export function disappearanceLine(
  shown: Shown,
  attempt: AttemptView | null,
  now: number,
): Line | undefined {
  if (shown.past) return undefined;
  if (shown.deadline !== undefined && now >= Date.parse(shown.deadline))
    return { tone: "error", text: MSG.signInExpired };
  return { tone: "error", text: attempt ? MSG.signInReplaced : MSG.signInEnded };
}

const isTyping = (el: Element | null) =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
const primaryOf = (panel: HTMLElement | null) =>
  panel?.closest("form")?.querySelector<HTMLElement>('button[type="submit"]') ?? null;

type Pending = "start" | "submit" | "wait" | "cancel";
type Ctx = { attemptId?: string; name?: string; before?: string | null };

export function useSignIn(o: {
  purpose: "create" | "replace";
  /** replace: the credential's name. */
  name?: string;
  /** The host form's own useFieldErrors (Add credential's `"name" | "value" | "code"`, the sheet's `"code"`). The
   *  hook calls set("name") only for purpose "create"; the Code field's error, change and blur go through it. */
  fields: Pick<FieldErrors<"name" | "code">, "set" | "errors" | "change" | "blur">;
  outcome: ReturnType<typeof useOutcome>;
  /** Read through a latest-ref; called once, by a mounted panel of the tab that submitted. */
  onDone(c: CredentialSummary): void;
}) {
  const qc = useQueryClient();
  const { data, refetch, isPending: loadingFirst } = useQuery(signInQueryOptions);
  const [code, setCodeState] = useState("");
  const [pending, setPending] = useState<Pending>();
  const [shown, setShown] = useState<Shown>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const focusReq = useRef<"link" | "primary" | null>(null);

  // advanced-use-latest: assigned in an effect, never during render.
  const onDoneRef = useRef(o.onDone);
  useLayoutEffect(() => {
    onDoneRef.current = o.onDone;
  });
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const raw = data?.attempt ?? null;
  const matches =
    raw !== null && raw.purpose === o.purpose && (o.purpose === "create" || raw.name === o.name);
  const mine = matches ? raw : null;
  const other = raw !== null && !matches && raw.state !== "settled";
  const available = data?.available ?? true;

  // Disappearance: state adjusted during render (the repo's pattern), settling in one extra render. No effect.
  const id = mine?.attemptId;
  const past = mine ? PAST_CODE.has(mine.state) : false;
  if (pending === undefined && (id !== shown.id || (id !== undefined && past !== shown.past)))
    setShown({
      id,
      deadline: mine?.codeDeadline ?? (id === shown.id ? shown.deadline : undefined),
      past,
      line:
        shown.id !== undefined && id !== shown.id
          ? disappearanceLine(shown, raw, Date.now())
          : shown.line,
    });

  // Derived in render (rerender-derived-state-no-effect).
  let phase: Phase;
  // Loading only while the first GET is pending: an errored one renders Idle, and Start's own answer decides.
  if (loadingFirst && pending === undefined) phase = "loading";
  else if (pending === "start") phase = "starting";
  else if (pending === "submit" || pending === "wait")
    phase = mine?.state === "verifying" ? "verifying" : "exchanging";
  // A line from a disappearance or an ending answer holds Idle until Start, even if another attempt arrived meanwhile.
  else phase = mine && !shown.line ? PHASE_OF[mine.state] : "idle";

  let line: Line | undefined;
  if (phase === "starting") line = HELP_LINE;
  else if (phase === "idle")
    line = shown.line ?? (other ? OTHER_LINE : available ? HELP_LINE : UNAVAILABLE_LINE);

  const pendingLabel =
    phase === "starting"
      ? "Starting…"
      : phase === "exchanging"
        ? "Signing in…"
        : phase === "verifying"
          ? "Verifying…"
          : undefined;

  /** H3: the one place every answer becomes UI (spec §8.2). Toast/onDone are the only mounted-only effects. */
  async function resolve(r: Result, ctx: Ctx) {
    const { attemptId } = ctx;
    if (r.ok === "aborted") {
      setPending(undefined);
      return;
    }
    let result = r;
    // A submitting client that gets 404 after the outcome was dropped: the credentials list may explain it.
    if (
      !result.ok &&
      result.error instanceof ApiError &&
      result.error.code === "sign_in_not_found" &&
      attemptId !== undefined &&
      submittedHere.has(attemptId)
    ) {
      const list = await qc
        .fetchQuery({ ...credentialsQueryOptions, staleTime: 0 })
        .catch(() => undefined);
      const found = list?.find((c) =>
        o.purpose === "create"
          ? c.name === ctx.name
          : c.name === ctx.name && c.expiresAt !== null && c.expiresAt !== ctx.before,
      );
      if (found) result = { ok: true, credential: found };
    }
    setPending(undefined);
    if (result.ok) {
      setCodeState("");
      setShown({});
      // Only a mounted panel renders it, and only then is the settled attempt cleared: a panel that mounts later
      // must still find it and join the wait (H1).
      if (!mountedRef.current || attemptId === undefined) return;
      patchAttempt(qc, attemptId, () => null);
      if (submittedHere.delete(attemptId)) onDoneRef.current(result.credential);
      return;
    }
    const e = result.error;
    if (attemptOf(e)) return; // The code never arrived: Ready again, the unspent code kept (spec §5.5).
    // A `sign_in_state` without an attempt leaves the id to whichever panel's submit owns it.
    if (attemptId !== undefined && !(e instanceof ApiError && e.code === "sign_in_state"))
      submittedHere.delete(attemptId);
    setCodeState("");
    if (!(e instanceof ApiError)) {
      o.outcome.fail(FORM_MSG.unreachable);
      return;
    }
    const fieldMap = (e.body.fields ?? {}) as Record<string, string | undefined>;
    if (e.code === "validation_error" && fieldMap.code) {
      o.fields.set("code", MSG.signInCode, { focus: true });
      return;
    }
    if (o.purpose === "create" && e.code === "credential_exists") {
      o.fields.set("name", FORM_MSG.nameTaken, { focus: true });
      return;
    }
    if (o.purpose === "create" && e.code === "validation_error" && fieldMap.name) {
      o.fields.set("name", fieldMap.name, { focus: true });
      return;
    }
    if (e.code === "sign_in_unavailable") {
      qc.setQueryData(KEY, (old) => ({ available: false, attempt: old?.attempt ?? null }));
      return;
    }
    if (NOT_ENDING.has(e.code)) {
      o.outcome.fail(e.message);
      return;
    }
    // Attempt-ending: Idle in the same commit, the message on the panel's line, focus on the primary.
    const text =
      e.code === "credential_not_found"
        ? MSG.credentialDeleted
        : e.code === "sign_in_not_found"
          ? MSG.signInEnded
          : e.message;
    setShown({ line: { tone: "error", text } });
    if (mountedRef.current && attemptId !== undefined) patchAttempt(qc, attemptId, () => null);
    focusReq.current = "primary";
  }

  async function start() {
    if (pending !== undefined) return;
    const from = document.activeElement;
    o.outcome.clear();
    setShown({});
    setCodeState("");
    setPending("start");
    try {
      const a = await startSignIn(o.purpose === "replace" ? { replace: o.name ?? "" } : {});
      writeAttempt(qc, a);
      setPending(undefined);
      // Unless the user moved focus meanwhile, Open sign-in page takes it (spec §8.2, L3).
      const now = document.activeElement;
      if (now === from || now === null || now === document.body) focusReq.current = "link";
    } catch (e) {
      await resolve({ ok: false, error: e }, {});
    }
  }

  async function submit(name?: string) {
    if (pending !== undefined || phase !== "ready" || mine?.state !== "awaiting_code") return;
    const attemptId = mine.attemptId;
    o.outcome.clear();
    const ctx: Ctx =
      o.purpose === "create"
        ? { attemptId, ...(name !== undefined ? { name } : {}) }
        : {
            attemptId,
            ...(o.name !== undefined ? { name: o.name } : {}),
            before:
              qc.getQueryData(credentialsQueryOptions.queryKey)?.find((c) => c.name === o.name)
                ?.expiresAt ?? null,
          };
    submittedHere.add(attemptId);
    const gen = generation;
    setPending("submit");
    let r: Result;
    try {
      const out = await submitSignInCode({
        attemptId,
        code,
        ...(o.purpose === "create" && name !== undefined ? { name } : {}),
      });
      if (out.kind === "done") r = finish(qc, attemptId, { ok: true, credential: out.credential });
      else {
        writeAttempt(qc, out.attempt);
        r = gen === generation ? await waitUntilDone(qc, attemptId) : ABORTED;
      }
    } catch (e) {
      // A network error or a bare/unhandled 5xx joins the wait (spec §8.3); a coded answer is the outcome.
      r = isRetryableWaitError(e)
        ? gen === generation
          ? await waitUntilDone(qc, attemptId)
          : ABORTED
        : finish(qc, attemptId, { ok: false, error: e });
    }
    await resolve(r, ctx);
  }

  async function cancel() {
    const a = mine;
    if (pending !== undefined || phase !== "ready" || !a) return;
    o.outcome.clear();
    setPending("cancel");
    try {
      await cancelSignIn(a.attemptId);
      inFlight.get(a.attemptId)?.controller.abort();
      patchAttempt(qc, a.attemptId, () => null);
      setShown({});
      setCodeState("");
      setPending(undefined);
    } catch (e) {
      setPending(undefined);
      o.outcome.fail(e instanceof ApiError ? e.message : FORM_MSG.unreachable);
    }
  }

  // One mount effect, for restore only: the first GET decides. Ready restores focus to the link; an attempt past
  // its code joins the tab's wait once (spec §5.4: a settled success renders only in the tab that submitted it).
  const loaded = data !== undefined;
  const restored = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the first GET has resolved
  useEffect(() => {
    if (!loaded || restored.current) return;
    restored.current = true;
    if (!mine) return;
    if (mine.state === "awaiting_code") {
      if (!isTyping(document.activeElement)) focusReq.current = "link";
      return;
    }
    if (!PAST_CODE.has(mine.state)) return;
    const attemptId = mine.attemptId;
    setPending("wait");
    void waitUntilDone(qc, attemptId).then((r) => resolve(r, { attemptId }));
  }, [loaded]);

  // Focus requested by a handler or the restore, applied once the target has rendered (useFocusLater's pattern, by
  // ref rather than id, so two panels never share an id).
  useEffect(() => {
    const want = focusReq.current;
    if (!want) return;
    const el =
      want === "link"
        ? panelRef.current?.querySelector<HTMLElement>("[data-sign-in-link]")
        : primaryOf(panelRef.current);
    if (el) {
      focusReq.current = null;
      el.focus();
    }
  });

  // The deadline: one timeout, no ticking (L2). It refetches; the disappearance rule then decides.
  const isReady = phase === "ready";
  const codeDeadline = mine?.codeDeadline;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `id` re-arms the timer for a new attempt (L2's primitive deps)
  useEffect(() => {
    if (!isReady || codeDeadline === undefined) return;
    const ms = Math.min(Math.max(0, Date.parse(codeDeadline) - Date.now()), 2 ** 31 - 1);
    const t = setTimeout(() => void refetch(), ms);
    return () => clearTimeout(t);
  }, [isReady, id, codeDeadline, refetch]);

  return {
    phase,
    attempt: mine,
    available,
    line,
    code,
    setCode(v: string) {
      setCodeState(v);
      o.fields.change("code");
    },
    codeError: o.fields.errors.code,
    blurCode(e: { relatedTarget: EventTarget | null }) {
      o.fields.blur("code", e);
    },
    start,
    submit,
    cancel,
    pendingLabel,
    panelRef: panelRef as RefObject<HTMLDivElement | null>,
  };
}

export type SignIn = ReturnType<typeof useSignIn>;
