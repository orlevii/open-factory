import { ApiError, apiFetch, type Me, meSchema, type PatchMeBody } from "@open-factory/shared";
import type { QueryClient } from "@tanstack/react-query";
import { type Session, sessionQueryOptions } from "@/lib/session";

/** `PATCH /api/me`: the signed-in person's own name and handle. */
export const patchMe = (body: PatchMeBody): Promise<Me> =>
  apiFetch("/api/me", { method: "PATCH", body, schema: meSchema });

/** Shows a saved profile at once; the `principal_updated` frame refreshes everything else that names the person. */
export function applyMe(qc: QueryClient, me: Me): void {
  const next: Session = { user: me };
  qc.setQueryData(sessionQueryOptions.queryKey, next);
}

/** What Undo on a rename toast runs: puts `old` back through `patch`, or says the handle was taken meanwhile. */
export async function undoRename(old: string, patch: (handle: string) => Promise<unknown>) {
  try {
    await patch(old);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409)
      throw new ApiError(409, err.code, `Couldn't undo: @${old} was taken`, err.body);
    throw err;
  }
}
