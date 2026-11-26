import { normaliseRef, type PrincipalItem } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { principalsQueryOptions, requestPrincipal } from "./api";

export type PrincipalLookup =
  | { status: "pending"; principal?: undefined }
  | { status: "unknown"; principal?: undefined }
  | { status: "found"; principal: PrincipalItem };

/** One principal by ref; re-renders only when that entry changes. A ref the cache lacks is fetched in a batch. */
export function usePrincipal(rawRef: string): PrincipalLookup {
  // The cache is keyed by canonical refs; a ref that can't be one is nobody.
  const ref = normaliseRef(rawRef) ?? rawRef;
  const qc = useQueryClient();
  const { data } = useQuery({
    ...principalsQueryOptions,
    select: (c): PrincipalLookup => {
      const principal = c.byRef.get(ref);
      if (principal) return { status: "found", principal };
      return { status: c.unknown.has(ref) || !normaliseRef(ref) ? "unknown" : "pending" };
    },
  });
  const status = data?.status;
  useEffect(() => {
    if (status === "pending") requestPrincipal(qc, ref);
  }, [qc, ref, status]);
  return data ?? { status: "pending" };
}

/** For rendering tags as plain text: the handle of a ref the cache knows. */
export function usePrincipalLookup(): (ref: string) => { ref: string; handle: string } | undefined {
  const { data } = useQuery(principalsQueryOptions);
  const byRef = data?.byRef;
  return useCallback(
    (ref) => {
      const p = byRef?.get(ref);
      return p && { ref: p.ref, handle: p.handle };
    },
    [byRef],
  );
}

/** The ref of whoever holds a handle, from the loaded cache: for a server list that names agents by handle. */
export function useRefOfHandle(): (handle: string) => string | undefined {
  const { data } = useQuery(principalsQueryOptions);
  const byHandle = useMemo(
    () => new Map([...(data?.byRef.values() ?? [])].map((p) => [p.handle, p.ref])),
    [data],
  );
  return useCallback((handle) => byHandle.get(handle), [byHandle]);
}
