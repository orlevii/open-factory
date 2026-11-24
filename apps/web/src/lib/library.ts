import {
  apiFetch,
  marketplaceDetailSchema,
  marketplaceFetchedSchema,
  type marketplacePreviewBodySchema,
  marketplacePreviewSchema,
  marketplacesResponseSchema,
  marketplaceViewSchema,
  pluginDetailSchema,
  pluginDiffSchema,
  pluginFileTextSchema,
  pluginsResponseSchema,
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

const SELECTORS_MAX = 200;

/** A `select` per key, made once and handed back every render. Bounded: past the cap the oldest is dropped (its next
 *  caller just builds a fresh one), so a long session opening many peeks doesn't grow the map without end. */
function memoSelectors<D, R>() {
  const cache = new Map<string, (data: D) => R>();
  return (key: string, make: () => (data: D) => R) => {
    let select = cache.get(key);
    if (select)
      cache.delete(key); // re-inserted below: the map's order is recency
    else {
      select = make();
      if (cache.size >= SELECTORS_MAX) cache.delete(cache.keys().next().value as string);
    }
    cache.set(key, select);
    return select;
  };
}

const rowSelectors = memoSelectors<SkillGroupsResponse, SkillRowView | undefined>();

/**
 * `select` for a peek reading one skill's row from the cached list (R-L2). Memoised per `(group, name)` at module level,
 * so a render hands `useQuery` the same function and it doesn't re-select on every render.
 */
export function selectSkillRow(group: string, name: string) {
  return rowSelectors(`${group}\0${name}`, () => (data) => {
    const g = data.groups.find((x) => x.group === group);
    const row = g?.skills.find((r) => r.name === name);
    return g && row ? { row, source: g.kind === "source" ? g.source : undefined } : undefined;
  });
}

const sourceSelectors = memoSelectors<SkillGroupsResponse, SourceGroup | undefined>();

/** `select` for a Source peek: the source's group (its summary and its skills' rows) from the cached list. */
export function selectSourceGroup(id: string) {
  return sourceSelectors(
    id,
    () => (data) =>
      data.groups.find((g): g is SourceGroup => g.kind === "source" && g.source.id === id),
  );
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

// Plugins and marketplaces (spec §9.1, §9.3).

export type PluginsResponse = z.infer<typeof pluginsResponseSchema>;
export type MarketplacesResponse = z.infer<typeof marketplacesResponseSchema>;

/** Every registered marketplace's catalog at the Library's commit, and the host's plugins of unregistered ones. */
export const pluginsQueryOptions = queryOptions({
  queryKey: ["library", "plugins"],
  queryFn: () => apiFetch("/api/library/plugins", { schema: pluginsResponseSchema }),
  staleTime: 0,
});

/** The registry rows, each with its plugins and users. */
export const marketplacesQueryOptions = queryOptions({
  queryKey: ["library", "marketplaces"],
  queryFn: () => apiFetch("/api/library/marketplaces", { schema: marketplacesResponseSchema }),
  staleTime: 0,
});

export type PluginFrom = "library" | "host";

const commitParams = (from: PluginFrom, commit: string | undefined) =>
  from === "host" ? "from=host" : commit ? `commit=${encodeURIComponent(commit)}` : "";

const withQuery = (path: string, ...params: string[]) => {
  const q = params.filter(Boolean).join("&");
  return q ? `${path}?${q}` : path;
};

/**
 * One plugin's contents and provenance. The key carries the commit and where it is read from, so the same plugin at two
 * commits (a pinned row and the Library's) is two cache entries.
 */
export const pluginQueryOptions = (key: string, from: PluginFrom, commit?: string) =>
  queryOptions({
    queryKey: ["library", "plugin", key, from, commit ?? ""],
    queryFn: () =>
      apiFetch(
        withQuery(`/api/library/plugins/${encodeURIComponent(key)}`, commitParams(from, commit)),
        {
          schema: pluginDetailSchema,
        },
      ),
  });

export const marketplaceQueryOptions = (name: string) =>
  queryOptions({
    queryKey: ["library", "marketplace", name],
    queryFn: () =>
      apiFetch(`/api/library/marketplaces/${encodeURIComponent(name)}`, {
        schema: marketplaceViewSchema,
      }),
  });

/** One file of a plugin (View file). Outside the `["library"]` prefix, like a skill's file: a commit's text can't change. */
export const pluginFileQueryOptions = (
  key: string,
  path: string,
  from: PluginFrom,
  commit: string | undefined,
) =>
  queryOptions({
    queryKey: ["library-file", "plugin", key, path, from, commit ?? ""],
    queryFn: () =>
      apiFetch(
        withQuery(
          `/api/library/plugins/${encodeURIComponent(key)}/file`,
          `path=${encodeURIComponent(path)}`,
          commitParams(from, commit),
        ),
        { schema: pluginFileTextSchema },
      ),
    staleTime: commit ? Number.POSITIVE_INFINITY : 0,
  });

type PluginEntry = PluginsResponse["marketplaces"][number]["plugins"][number];
type HostEntry = PluginsResponse["host"][number];
export type PluginRowView =
  | { from: "library"; entry: PluginEntry; marketplace: string; commit: string | null }
  | { from: "host"; entry: HostEntry };

const pluginSelectors = memoSelectors<PluginsResponse, PluginRowView | undefined>();

/** `select` for a peek reading one plugin's row (module-level and memoised per `(key, from)`, R-L2). */
export function selectPluginRow(key: string, from: PluginFrom) {
  return pluginSelectors(`${from}\0${key}`, () => (data) => {
    if (from === "host") {
      const entry = data.host.find((h) => h.key === key);
      return entry ? { from: "host", entry } : undefined;
    }
    for (const m of data.marketplaces) {
      const entry = m.plugins.find((p) => p.key === key);
      if (entry) return { from: "library", entry, marketplace: m.name, commit: m.commit };
    }
    return undefined;
  });
}

export type MarketplaceRow = MarketplacesResponse["marketplaces"][number];
const marketplaceSelectors = memoSelectors<MarketplacesResponse, MarketplaceRow | undefined>();

/** `select` for a Marketplace peek: its row (with its plugins and users) from the cached list. */
export function selectMarketplaceRow(name: string) {
  return marketplaceSelectors(name, () => (data) => data.marketplaces.find((m) => m.name === name));
}

export type MarketplacePreviewBody = z.infer<typeof marketplacePreviewBodySchema>;
const marketUrl = (name: string, action?: string) =>
  `/api/library/marketplaces/${encodeURIComponent(name)}${action ? `/${action}` : ""}`;

/** Step 1 of Add marketplace. `signal` cancels it (Close, a newer Find). */
export const previewMarketplace = (body: MarketplacePreviewBody, signal?: AbortSignal) =>
  post("/api/library/marketplaces/preview", marketplacePreviewSchema, body, signal);
/** Step 2: adds the previewed marketplace (201, or 202 with an `adding` row while it re-fetches). */
export const addMarketplace = (previewId: string) =>
  post("/api/library/marketplaces", marketplaceDetailSchema, { previewId });
export const checkMarketplace = (name: string) =>
  post(marketUrl(name, "check"), marketplaceDetailSchema);
export const updateMarketplace = (name: string, commit: string) =>
  post(marketUrl(name, "update"), marketplaceDetailSchema, { commit });
export const fetchMarketplaceRef = (name: string, ref: string) =>
  post(marketUrl(name, "fetch"), marketplaceFetchedSchema, { ref });
export const removeMarketplace = (name: string) =>
  apiFetch(marketUrl(name), { method: "DELETE", schema: sourceRemovedSchema });
export const restoreMarketplace = (name: string) =>
  post(marketUrl(name, "restore"), marketplaceDetailSchema);
/** Fetches an external `sha` source so its contents can be shown (Read contents). */
export const readPlugin = (key: string, commit?: string) =>
  post(`/api/library/plugins/${encodeURIComponent(key)}/read`, pluginDetailSchema, {
    ...(commit ? { commit } : {}),
  });
/** What a plugin changes between two commits (or recorded tags) of its marketplace: the review of a repin. */
export const diffPlugin = (key: string, from: string, to: string) =>
  post(`/api/library/plugins/${encodeURIComponent(key)}/diff`, pluginDiffSchema, { from, to });
export const addHostMarketplace = (key: string) =>
  post(
    `/api/library/host-plugins/${encodeURIComponent(key)}/add-marketplace`,
    marketplaceDetailSchema,
  );

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
