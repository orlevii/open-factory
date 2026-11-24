import {
  apiFetch,
  skillDetailSchema,
  skillGroupsResponseSchema,
  sourceViewSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";

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
