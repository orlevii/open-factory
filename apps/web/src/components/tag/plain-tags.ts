import { renderTags, type TagPrincipal } from "@open-factory/shared/tags";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import {
  type PrincipalsCache,
  principalsQueryOptions,
  requestPrincipal,
} from "@/features/principals/api";

type Plain = { text: string; pending: string[] };

function render(text: string, cache: PrincipalsCache | undefined): Plain {
  const pending: string[] = [];
  const out = renderTags(
    text,
    (ref): TagPrincipal | undefined => {
      const p = cache?.byRef.get(ref);
      if (p) return p;
      // Nobody until the server says so; until then `@…`, like the chip.
      if (cache?.unknown.has(ref)) return undefined;
      pending.push(ref);
      return { ref, handle: "…" };
    },
    "plain",
  );
  return { text: out, pending: cache ? pending : [] };
}

/** The text with each `<@ref>` as `@handle`, for surfaces that can't show a chip (a row title, the document title).
 *  A ref the cache lacks reads `@…` and is fetched; `@unknown` only once the server has said so. */
export function usePlainTags(text: string): string {
  const qc = useQueryClient();
  const { data } = useQuery({
    ...principalsQueryOptions,
    select: useCallback((c: PrincipalsCache) => render(text, c), [text]),
  });
  const pending = data?.pending;
  useEffect(() => {
    for (const ref of pending ?? []) requestPrincipal(qc, ref);
  }, [qc, pending]);
  return data?.text ?? render(text, undefined).text;
}
