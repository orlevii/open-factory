import {
  apiFetch,
  type ServerMessage,
  type SkillGroupsResponse,
  skillDetailSchema,
  skillFileTextSchema,
  skillGroupsResponseSchema,
  type skillSourceAddBodySchema,
  type skillSourcePreviewBodySchema,
  sourceDetailSchema,
  sourcePreviewSchema,
  sourceRemovedSchema,
  sourceViewSchema,
} from "@open-factory/shared";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
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

/**
 * One text file of a skill. Outside the `["library"]` prefix on purpose: a `library_changed` frame never refetches file
 * text. A pinned source's file can't change, so it never goes stale; a live one (`pin` null) refetches as usual.
 */
export const skillFileQueryOptions = (
  group: string,
  name: string,
  path: string,
  pin: string | null,
) =>
  queryOptions({
    queryKey: ["library-file", group, name, path, pin ?? ""],
    queryFn: () =>
      apiFetch(
        `/api/library/skills/${encodeURIComponent(group)}/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`,
        { schema: skillFileTextSchema },
      ),
    staleTime: pin ? Number.POSITIVE_INFINITY : 0,
  });

type Group = SkillGroupsResponse["groups"][number];
type SourceGroup = Extract<Group, { kind: "source" }>;
export type SkillRowView = {
  row: Group["skills"][number];
  source: SourceGroup["source"] | undefined;
};

const rowSelectors = new Map<string, (data: SkillGroupsResponse) => SkillRowView | undefined>();

/**
 * `select` for a peek reading one skill's row from the cached list (R-L2). Memoised per `(group, name)` at module level,
 * so a render hands `useQuery` the same function and it doesn't re-select on every render.
 */
export function selectSkillRow(group: string, name: string) {
  const key = `${group}\0${name}`;
  let select = rowSelectors.get(key);
  if (!select) {
    select = (data) => {
      const g = data.groups.find((x) => x.group === group);
      const row = g?.skills.find((r) => r.name === name);
      return g && row ? { row, source: g.kind === "source" ? g.source : undefined } : undefined;
    };
    rowSelectors.set(key, select);
  }
  return select;
}

const sourceSelectors = new Map<string, (data: SkillGroupsResponse) => SourceGroup | undefined>();

/** `select` for a Source peek: the source's group (its summary and its skills' rows) from the cached list. */
export function selectSourceGroup(id: string) {
  let select = sourceSelectors.get(id);
  if (!select) {
    select = (data) =>
      data.groups.find((g): g is SourceGroup => g.kind === "source" && g.source.id === id);
    sourceSelectors.set(id, select);
  }
  return select;
}

export type SkillSourcePreviewBody = z.infer<typeof skillSourcePreviewBodySchema>;
export type SkillSourceAddBody = z.infer<typeof skillSourceAddBodySchema>;

// Source actions (spec §9.2). POSTs are mutations, started from handlers (R-Q1), never queries.
const sourceUrl = (id: string, action?: string) =>
  `/api/library/sources/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
const post = <T>(url: string, schema: z.ZodType<T>, body: unknown = {}, signal?: AbortSignal) =>
  apiFetch(url, { method: "POST", body, schema, ...(signal ? { signal } : {}) });

/** Step 1 of Add skills: what a folder or GitHub source holds. `signal` cancels it (Close, a newer Find). */
export const previewSkillSource = (body: SkillSourcePreviewBody, signal?: AbortSignal) =>
  post("/api/library/sources/preview", sourcePreviewSchema, body, signal);
/** Step 2: adds the source with the picked skills (201, or 202 while a GitHub add re-fetches). */
export const addSkillSource = (body: SkillSourceAddBody) =>
  post("/api/library/sources", sourceDetailSchema, body);

export const checkSource = (id: string) => post(sourceUrl(id, "check"), sourceDetailSchema);
export const updateSource = (id: string, commit: string) =>
  post(sourceUrl(id, "update"), sourceDetailSchema, { commit });
export const refetchSource = (id: string) => post(sourceUrl(id, "fetch"), sourceDetailSchema);
export const findSkills = (id: string) => post(sourceUrl(id, "find"), sourcePreviewSchema);
export const addSkillsTo = (id: string, skills: string[]) =>
  post(sourceUrl(id, "add"), sourceDetailSchema, { skills });
export const removeSource = (id: string) =>
  apiFetch(sourceUrl(id), { method: "DELETE", schema: sourceRemovedSchema });
export const restoreSource = (id: string) => post(sourceUrl(id, "restore"), sourceDetailSchema);

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
  invalidateLibrary(qc);
}

/**
 * Schedules the coalesced `["library"]` refetch without a frame. A template or agent config change (`config_changed`) moves
 * the template-local lists and the used-by counts (spec §9.5), and shares the same 250 ms window as `library_changed`.
 */
export function invalidateLibrary(qc: QueryClient) {
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    void qc.invalidateQueries({ queryKey: ["library"] });
  }, COALESCE_MS);
}
