import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * A stacked sheet's new item joins its list (§7, React review M8). In-flight fetches of the list are cancelled first:
 * one that started before the item existed would land without it, and a cancel made after the write would revert the
 * list to its state before that fetch, dropping the item again. An unfetched list stays unfetched.
 * Then `refreshList` refetches it in the background (active queries only).
 */
export async function writeToList<T>(qc: QueryClient, queryKey: QueryKey, add: (old: T) => T) {
  await qc.cancelQueries({ queryKey, exact: true });
  qc.setQueryData<T>(queryKey, (old) => (old === undefined ? old : add(old)));
}

export function refreshList(qc: QueryClient, queryKey: QueryKey) {
  void qc.invalidateQueries({ queryKey, exact: true, refetchType: "active" });
}

/** Appends `item`, replacing one with its name. */
export const withItem =
  <I extends { name: string }>(item: I) =>
  (old: I[]) => [...old.filter((x) => x.name !== item.name), item];
