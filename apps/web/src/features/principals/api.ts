import {
  apiFetch,
  MAX_PRINCIPAL_REFS,
  normaliseRef,
  type PrincipalItem,
  principalsResponseSchema,
} from "@open-factory/shared";
import { type QueryClient, queryOptions } from "@tanstack/react-query";

export interface PrincipalsCache {
  byRef: Map<string, PrincipalItem>;
  /** Refs the server was asked about and doesn't know. */
  unknown: Set<string>;
}

/** Everyone, fetched once; tags that name someone newer join through `requestPrincipal`'s batches. */
export const principalsQueryOptions = queryOptions({
  queryKey: ["principals"],
  queryFn: async ({ client }): Promise<PrincipalsCache> => {
    const { principals } = await apiFetch("/api/principals", { schema: principalsResponseSchema });
    const byRef = new Map(principals.map((p) => [p.ref, p]));
    // A refetch keeps what was learned to be nobody (the batch won't ask again), unless the list has them now.
    const previous = client.getQueryData<PrincipalsCache>(["principals"]);
    const unknown = new Set([...(previous?.unknown ?? [])].filter((r) => !byRef.has(r)));
    return { byRef, unknown };
  },
  staleTime: Number.POSITIVE_INFINITY,
});

/** Adds principals (and refs known to be nobody) to a loaded cache; a cache that hasn't loaded fetches everyone anyway. */
export function mergePrincipals(
  qc: QueryClient,
  items: PrincipalItem[],
  unknownRefs: string[] = [],
): void {
  qc.setQueryData<PrincipalsCache>(principalsQueryOptions.queryKey, (old) => {
    if (!old) return old;
    const byRef = new Map(old.byRef);
    const unknown = new Set(old.unknown);
    for (const p of items) {
      byRef.set(p.ref, p);
      unknown.delete(p.ref);
    }
    for (const r of unknownRefs) if (!byRef.has(r)) unknown.add(r);
    return { byRef, unknown };
  });
}

/**
 * The queries whose data renders a handle field (their responses carry handles as strings, not refs). A rename or a
 * new principal invalidates each; mounted ones refetch once, the rest when next used. Chats are left out: they read
 * handles through the principals cache. Reconnecting invalidates every non-chat query, so a missed frame is covered.
 */
export const HANDLE_QUERY_KEYS = [
  ["agents"], // agent lists: handle, reportsTo, spawner
  ["agent"], // an agent's detail: handle, reportsTo, spawner
  ["inbox"], // rows: sender, subject, mentioned and held-by handles
  ["tasks"], // lists, details, search and per-agent: creator, assignee, comment authors
  ["schedules"], // lists and details: target, creator, owner
  ["usage"], // per-agent and per-credential rows: handle, spawner
  ["users"], // the admin list: each person's handle
  ["credentials"], // rows: usedBy and archivedUsedBy agent handles
  ["secrets"], // rows: usedBy and archivedUsedBy agent handles
  ["session"], // the signed-in person's own handle (`/api/me`)
] as const;

/** `principal_updated`: patches the principals cache with the item and refreshes every query that shows handles. */
export function applyPrincipalUpdated(qc: QueryClient, item: PrincipalItem): void {
  mergePrincipals(qc, [item]);
  for (const queryKey of HANDLE_QUERY_KEYS) void qc.invalidateQueries({ queryKey });
}

/** The ref of the principal with this handle, from the loaded cache (a send's optimistic entry names refs). */
export function refOfHandle(qc: QueryClient, handle: string): string | undefined {
  const cache = qc.getQueryData<PrincipalsCache>(principalsQueryOptions.queryKey);
  if (!cache) return undefined;
  for (const p of cache.byRef.values()) if (p.handle === handle) return p.ref;
  return undefined;
}

interface Batch {
  queued: Set<string>;
  /** Asked for already: not asked again while the answer is pending or after it came back. */
  asked: Set<string>;
  scheduled: boolean;
}
const batches = new WeakMap<QueryClient, Batch>();

/**
 * Asks the server for a ref the loaded cache lacks. Refs requested in the same animation frame go out as one
 * `?refs=` request; the answer is merged, and a ref the server left out becomes unknown.
 */
export function requestPrincipal(qc: QueryClient, rawRef: string): void {
  const ref = normaliseRef(rawRef);
  if (!ref) return;
  const b = batches.get(qc) ?? { queued: new Set(), asked: new Set(), scheduled: false };
  batches.set(qc, b);
  if (b.asked.has(ref)) return;
  b.asked.add(ref);
  b.queued.add(ref);
  if (b.scheduled) return;
  b.scheduled = true;
  const batch = b;
  requestAnimationFrame(() => {
    batch.scheduled = false;
    const all = [...batch.queued];
    batch.queued.clear();
    for (let i = 0; i < all.length; i += MAX_PRINCIPAL_REFS) {
      const refs = all.slice(i, i + MAX_PRINCIPAL_REFS);
      void apiFetch(`/api/principals?refs=${refs.join(",")}`, { schema: principalsResponseSchema })
        .then(({ principals }) => {
          const found = new Set(principals.map((p) => p.ref));
          mergePrincipals(
            qc,
            principals,
            refs.filter((r) => !found.has(r)),
          );
        })
        .catch(() => {
          // Still pending: a later mount asks again.
          for (const r of refs) batch.asked.delete(r);
        });
    }
  });
}
