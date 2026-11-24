import {
  apiFetch,
  type ServerMessage,
  skillDetailSchema,
  skillGroupsResponseSchema,
  sourceViewSchema,
} from "@open-factory/shared";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { notify } from "@/components/ui/toaster";

// Keys are arrays of primitives under the `["library"]` prefix, which a `library_changed` frame invalidates.

/**
 * Every skill group (spec §9.1). staleTime 0, so a window focus refreshes the host and template-local lists, which
 * have no watcher (spec §9.5).
 */
export const libraryQueryOptions = queryOptions({
  queryKey: ["library", "skills"],
  queryFn: () => apiFetch("/api/library/skills", { schema: skillGroupsResponseSchema }),
  staleTime: 0,
});

/** `group` is the URL form: `host`, `source:<id>`, `template:<name>` or `unknown`. */
export const skillQueryOptions = (group: string, name: string) =>
  queryOptions({
    queryKey: ["library", "skill", group, name],
    queryFn: () =>
      apiFetch(`/api/library/skills/${encodeURIComponent(group)}/${encodeURIComponent(name)}`, {
        schema: skillDetailSchema,
      }),
  });

export const sourceQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ["library", "source", id],
    queryFn: () =>
      apiFetch(`/api/library/sources/${encodeURIComponent(id)}`, { schema: sourceViewSchema }),
  });

/** A `library_changed` frame (spec §9.5). */
export type LibraryChanged = Extract<ServerMessage, { type: "library_changed" }>;

const COALESCE_MS = 250;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Drops a pending window (tests: a window must not leak into the next one). */
export function resetLibraryChanged() {
  clearTimeout(timer);
  timer = undefined;
}

/**
 * Handles a `library_changed` frame (spec §9.5, R-Q3): the whole `["library"]` prefix refetches once per 250 ms
 * trailing window, however many frames land in it (a check-all sends one per source). The timer is module-level, never per
 * render. A failed background add is a toast, shown per frame at once and never coalesced away.
 */
export function onLibraryChanged(qc: QueryClient, frame: LibraryChanged) {
  if (frame.addFailed !== undefined) notify({ text: `Couldn't add ${frame.addFailed}.` });
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    void qc.invalidateQueries({ queryKey: ["library"] });
  }, COALESCE_MS);
}
