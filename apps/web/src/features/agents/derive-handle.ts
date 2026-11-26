import { handleSchema, RESERVED_HANDLES } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { agentsListQueryOptions } from "@/features/agents/api";
import { usersQueryOptions } from "@/features/settings/api";

const MAX = 40;

/** Letters NFKD leaves alone, folded to their ASCII spelling (capitals too). */
const FOLD: Readonly<Record<string, string>> = {
  ł: "l",
  ø: "o",
  ß: "ss",
  ẞ: "ss",
  æ: "ae",
  œ: "oe",
  đ: "d",
  ı: "i",
  þ: "th",
};
const FOLD_RE = /[łøßẞæœđıþ]/gi;

export function foldLetters(s: string): string {
  return s.replace(FOLD_RE, (c) => {
    const f = FOLD[c.toLowerCase()] ?? c;
    return c === c.toLowerCase() ? f : f.charAt(0).toUpperCase() + f.slice(1);
  });
}

const trimHyphens = (s: string) => s.replace(/^-+|-+$/g, "");

/** An agent's address from its display name (§6.3): "" when nothing survives or it isn't a valid
 *  handle; a taken address gets -2, -3, … with the base cut so the whole fits 40 characters. */
export function deriveHandle(name: string, taken: ReadonlySet<string>): string {
  const base = trimHyphens(
    foldLetters(name)
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-"),
  );
  const cut = trimHyphens(base.slice(0, MAX));
  if (!cut) return "";
  let handle = cut;
  for (let n = 2; taken.has(handle); n++) {
    const suffix = `-${n}`;
    handle = trimHyphens(cut.slice(0, MAX - suffix.length)) + suffix;
  }
  return handleSchema.safeParse(handle).success ? handle : "";
}

/** Every address the server refuses: agent handles (archived included), human handles and the reserved
 *  ones. undefined until the lists answered. Callers must always derive against this set: without
 *  it a reserved name like "Me" derives "" (handleSchema refuses it) instead of "me-2". */
export function useTakenNames(enabled: boolean): ReadonlySet<string> | undefined {
  const active = useQuery({ ...agentsListQueryOptions("exclude"), enabled });
  const archived = useQuery({ ...agentsListQueryOptions("only"), enabled });
  const users = useQuery({ ...usersQueryOptions, enabled });
  // One Set per answer, not one per render.
  return useMemo(
    () =>
      active.data && archived.data && users.data
        ? new Set([
            ...active.data.map((a) => a.handle),
            ...archived.data.map((a) => a.handle),
            ...users.data.map((u) => u.handle),
            ...RESERVED_HANDLES,
          ])
        : undefined,
    [active.data, archived.data, users.data],
  );
}
