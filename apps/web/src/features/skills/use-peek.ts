import { useCallback, useState } from "react";

/** What a peek shows. A skill's id is `<group>/<name>` (the fix item's shape, spec §8.4). */
export type PeekTarget = { kind: "skill" | "source"; id: string };

/** A peek's key: the string rows compare against, so a row takes a boolean and nothing else. */
export const peekKeyOf = (t: PeekTarget) => `${t.kind}:${t.id}`;
export const skillKey = (group: string, name: string) =>
  peekKeyOf({ kind: "skill", id: `${group}/${name}` });
export const sourceKey = (id: string) => peekKeyOf({ kind: "source", id });

export function parsePeekKey(key: string): PeekTarget | undefined {
  const i = key.indexOf(":");
  const kind = key.slice(0, i);
  return kind === "skill" || kind === "source" ? { kind, id: key.slice(i + 1) } : undefined;
}

/** The page's one peek (not in the URL, D11). `show` retargets in place; both handlers are stable. */
export function usePeek() {
  const [key, setKey] = useState<string | null>(null);
  const close = useCallback(() => setKey(null), []);
  return { key, show: setKey, close };
}
export type PeekControl = ReturnType<typeof usePeek> & { focus(): void };
