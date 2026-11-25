import type { SkillGroupsResponse } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { libraryQueryOptions } from "@/lib/library";
import { arrive, useArrivalTint } from "@/lib/use-arrival";
import { parsePeekKey, peekKeyOf } from "./use-peek";

const arrivalState = z.object({
  peek: z.object({ kind: z.enum(["skill", "source"]), id: z.string() }),
});

/** The peek key a navigation carries in router state (`{ peek: item }`, spec §10.7), if any. */
function peekKeyFromState(state: unknown): string | undefined {
  const r = arrivalState.safeParse(state);
  return r.success ? peekKeyOf(r.data.peek) : undefined;
}

/** Whether the cached Library holds the row a peek key names. */
function hasRow(data: SkillGroupsResponse, key: string | undefined): boolean {
  const target = key === undefined ? undefined : parsePeekKey(key);
  if (!target) return false;
  if (target.kind === "source")
    return data.groups.some((g) => g.kind === "source" && g.source.id === target.id);
  const slash = target.id.lastIndexOf("/");
  const group = target.id.slice(0, slash);
  const name = target.id.slice(slash + 1);
  return data.groups.some((g) => g.group === group && g.skills.some((s) => s.name === name));
}

/**
 * A fix link or "Open in Skills" arrives with `{ peek: item }` in router state (R6, R-L4). The view opens the item's
 * peek (adjusted while rendering, so a second arrival on the mounted page, a new history entry, opens its peek too),
 * and once its row exists scrolls it to the centre and focuses it with the arrival tint. The scroll happens once per
 * arrival: a later `library_changed` refetch never scrolls again. `setPeek` must be the owning component's own state
 * setter. Returns the tint for the arrived row.
 */
export function useLibraryArrival(setPeek: (key: string) => void) {
  const peekKey = useLocation({ select: (l) => peekKeyFromState(l.state) });
  const arrivalKey = useLocation({ select: (l) => l.state.__TSR_key });
  // The router gives every history entry a key; without one (a bare test router) no arrival is detected.
  const [arrivedKey, setArrivedKey] = useState<string>();
  if (peekKey !== undefined && arrivalKey !== arrivedKey) {
    setArrivedKey(arrivalKey);
    setPeek(peekKey);
  }
  const { arrival, start, onArrivedEnd } = useArrivalTint();
  const select = useCallback((data: SkillGroupsResponse) => hasRow(data, peekKey), [peekKey]);
  const { data: rowFound = false } = useQuery({ ...libraryQueryOptions, select });
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
