import type { SkillGroupsResponse } from "@open-factory/shared";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { libraryQueryOptions } from "@/lib/library";
import { arrive, useArrivalTint } from "@/lib/use-arrival";
import { PEEK_KINDS, type PeekTarget, parsePeekKey, peekKeyOf } from "./use-peek";

/** The router state that lands an item's peek on its view (spec §10.7). The router types its history state as closed, so
 *  this is the one cast; `peekKeyFromState` below parses it back. */
export const arrivalState = (peek: PeekTarget) => ({ peek }) as never;

const arrivalSchema = z.object({
  peek: z.object({ kind: z.enum(PEEK_KINDS), id: z.string() }),
});

/** The peek key a navigation carries in router state (`{ peek: item }`, spec §10.7), if any. */
function peekKeyFromState(state: unknown): string | undefined {
  const r = arrivalSchema.safeParse(state);
  return r.success ? peekKeyOf(r.data.peek) : undefined;
}

/** The view an arrival lands on: the query that holds its rows, and whether a row is in the data. Module-level
 *  constants, so the `select` built from one is stable. */
export type ArrivalView<T> = {
  options: UseQueryOptions<T, Error, T, string[]>;
  has(data: T, target: PeekTarget): boolean;
};

export const SKILLS_ARRIVAL: ArrivalView<SkillGroupsResponse> = {
  options: libraryQueryOptions,
  has(data, target) {
    if (target.kind === "source")
      return data.groups.some((g) => g.kind === "source" && g.source.id === target.id);
    const slash = target.id.lastIndexOf("/");
    const group = target.id.slice(0, slash);
    const name = target.id.slice(slash + 1);
    return data.groups.some((g) => g.group === group && g.skills.some((s) => s.name === name));
  },
};

/**
 * A fix link or "Open in Skills" arrives with `{ peek: item }` in router state (R6, R-L4). The view opens the item's
 * peek (adjusted while rendering, so a second arrival on the mounted page, a new history entry, opens its peek too),
 * and once its row exists scrolls it to the centre and focuses it with the arrival tint. The scroll happens once per
 * arrival: a later `library_changed` refetch never scrolls again. `setPeek` must be the owning component's own state
 * setter. Returns the tint for the arrived row.
 */
export function useLibraryArrival<T>(setPeek: (key: string) => void, view: ArrivalView<T>) {
  const peekKey = useLocation({ select: (l) => peekKeyFromState(l.state) });
  const arrivalKey = useLocation({ select: (l) => l.state.__TSR_key });
  // The router gives every history entry a key; without one (a bare test router) no arrival is detected.
  const [arrivedKey, setArrivedKey] = useState<string>();
  if (peekKey !== undefined && arrivalKey !== arrivedKey) {
    setArrivedKey(arrivalKey);
    setPeek(peekKey);
  }
  const { arrival, start, onArrivedEnd } = useArrivalTint();
  const { options, has } = view;
  const select = useCallback(
    (data: T) => {
      const target = peekKey === undefined ? undefined : parsePeekKey(peekKey);
      return target !== undefined && has(data, target);
    },
    [peekKey, has],
  );
  const { data: rowFound = false } = useQuery({ ...options, select });
  const scrolled = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per arrival; `start` is stable
  useEffect(() => {
    if (peekKey === undefined || !rowFound || scrolled.current === (arrivalKey ?? "")) return;
    scrolled.current = arrivalKey ?? "";
    const row = document.querySelector<HTMLElement>(`[data-peek-key="${CSS.escape(peekKey)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center" }); // arrive() focuses without scrolling
    arrive(row);
    start();
  }, [arrivalKey, rowFound]);
  return { arrivedKey: peekKey, arrival, onArrivedEnd };
}
