import {
  ApiError,
  type AttemptView,
  apiFetch,
  attemptResponseSchema,
  type CredentialSummary,
  credentialSummarySchema,
  signInStatusSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";

export const signInQueryOptions = queryOptions({
  queryKey: ["claude-sign-in"],
  // A prefetch in the route loader and the mount right after it don't double-GET.
  staleTime: 2_000,
  refetchOnWindowFocus: true,
  // A failed GET shows Idle at once (spec §8.2) instead of a blank panel through the app's retries.
  retry: false,
  queryFn: ({ signal }) => apiFetch("/api/claude-sign-in", { schema: signInStatusSchema, signal }),
});

/**
 * A `create` attempt still in progress (never `settled`, spec §8.1): Settings opens its inline add form for one.
 * Module-level, so a `select` using it stays stable and the section re-renders only when the boolean flips.
 */
export function isLiveCreate(s: { attempt: AttemptView | null }): boolean {
  const a = s.attempt;
  return a !== null && a.purpose === "create" && a.state !== "settled";
}

export type SignInOutcome =
  | { kind: "done"; credential: CredentialSummary }
  | { kind: "pending"; attempt: AttemptView };

// 201 and 200 carry the credential, 202 the attempt still working.
const outcomeSchema = z.union([
  z
    .object({ credential: credentialSummarySchema })
    .transform((r): SignInOutcome => ({ kind: "done", credential: r.credential })),
  attemptResponseSchema.transform((r): SignInOutcome => ({ kind: "pending", attempt: r.attempt })),
]);

export const startSignIn = (body: { replace?: string }, signal?: AbortSignal) =>
  apiFetch("/api/claude-sign-in", {
    method: "POST",
    body,
    schema: attemptResponseSchema,
    ...(signal ? { signal } : {}),
  }).then((r) => r.attempt);

export const submitSignInCode = (b: { attemptId: string; code: string; name?: string }) =>
  apiFetch("/api/claude-sign-in/code", { method: "POST", body: b, schema: outcomeSchema });

export const waitSignIn = (attemptId: string, signal?: AbortSignal) =>
  apiFetch("/api/claude-sign-in/code/wait", {
    method: "POST",
    body: { attemptId },
    schema: outcomeSchema,
    ...(signal ? { signal } : {}),
  });

/** An attempt that already ended may 404: the goal (no attempt) is met. */
export const cancelSignIn = (attemptId: string) =>
  apiFetch(`/api/claude-sign-in/${encodeURIComponent(attemptId)}`, {
    method: "DELETE",
    schema: z.undefined(),
  }).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return;
    throw e;
  });

/**
 * A wait that may simply be asked again (spec §8.3: "a network error or a 5xx from code joins the wait"): the network
 * dropped, a gateway answered with a bare HTTP status, or the server's own unhandled 5xx (`internal_error`). A coded
 * business error (`sign_in_failed`, `claude_unreachable`, …) is the outcome and never retries.
 */
export function isRetryableWaitError(err: unknown): boolean {
  if (err instanceof ApiError) return /^http_\d+$/.test(err.code) || err.code === "internal_error";
  return err instanceof TypeError;
}
