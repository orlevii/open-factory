import { type AgentRow, schema } from "@open-factory/db";
import { normaliseRef, RESERVED_HANDLES } from "@open-factory/shared";
import { plainTagWarning } from "@open-factory/shared/tags";
import { eq } from "drizzle-orm";
import {
  type Principal,
  principalsByHandles,
  principalsByRefs,
  type Tx,
} from "./principal-store.ts";

/** `@humans` was an address for every person; people are addressed by handle now (spec §4.5). */
export const HUMANS_SEND_REFUSAL =
  "`@humans` isn't a handle. Message people by handle; list_peers lists them.";

export type ArgResolution =
  | { kind: "principal"; p: Principal; warning?: string }
  | { kind: "reserved"; name: string }
  | { kind: "channel"; name: string }
  | { kind: "unknown_ref"; ref: string }
  | { kind: "none"; name: string };

const RESERVED: readonly string[] = RESERVED_HANDLES;
/** A full tag: its name may be a ref in any case, or a handle written in a ref's place; the label is ignored. */
const TAG = /^<@([0-9A-Za-z][0-9A-Za-z-]*)(?:\|[^<>\n]*)?>$/;

type Parsed =
  | { kind: "channel"; name: string }
  | { kind: "tag"; name: string; ref: string | undefined; written: string }
  | { kind: "plain"; raw: string; ref: string | undefined; name: string };

function parse(raw: string): Parsed {
  if (raw.startsWith("#")) return { kind: "channel", name: raw };
  const tag = TAG.exec(raw);
  if (tag) {
    const x = tag[1] as string;
    return { kind: "tag", name: x.toLowerCase(), ref: normaliseRef(x), written: raw };
  }
  return {
    kind: "plain",
    raw,
    ref: normaliseRef(raw),
    name: raw.startsWith("@") ? raw.slice(1) : raw,
  };
}

/**
 * Resolves principal arguments with one lookup by ref and one by handle. Accepts `<@ref|…>`, `<@ref>`, a bare ref,
 * `@handle` or `handle`. A plain handle resolves with a warning; only a full tag whose ref is unknown is `unknown_ref`.
 * Archived and ended agents resolve (callers refuse them).
 */
export async function resolveArgs(tx: Tx, raws: readonly string[]): Promise<ArgResolution[]> {
  const parsed = raws.map((r) => parse(r.trim()));
  const refs = new Set<string>();
  const handles = new Set<string>();
  for (const p of parsed) {
    if (p.kind === "channel") continue;
    if (p.ref) refs.add(p.ref);
    if (p.kind === "tag") handles.add(p.name);
    else if (!RESERVED.includes(p.name)) handles.add(p.name);
  }
  const [byRef, byHandle] = await Promise.all([
    principalsByRefs(tx, [...refs]),
    principalsByHandles(tx, [...handles]),
  ]);
  const warn = (written: string, p: Principal) =>
    plainTagWarning({ written, ref: p.ref, handle: p.handle });
  return parsed.map((p): ArgResolution => {
    if (p.kind === "channel") return { kind: "channel", name: p.name };
    const known = p.ref ? byRef.get(p.ref) : undefined;
    if (p.kind === "tag") {
      if (known) return { kind: "principal", p: known };
      const asHandle = byHandle.get(p.name);
      if (asHandle) return { kind: "principal", p: asHandle, warning: warn(p.written, asHandle) };
      return { kind: "unknown_ref", ref: p.ref ?? p.name };
    }
    if (known) return { kind: "principal", p: known };
    if (RESERVED.includes(p.name)) return { kind: "reserved", name: p.name };
    const hit = byHandle.get(p.name);
    if (hit) return { kind: "principal", p: hit, warning: warn(`@${p.name}`, hit) };
    return { kind: "none", name: p.name };
  });
}

export const resolveArg = async (tx: Tx, raw: string): Promise<ArgResolution> =>
  (await resolveArgs(tx, [raw]))[0] as ArgResolution;

export type AgentArg =
  | { kind: "agent"; row: AgentRow; handle: string; warning?: string }
  | { kind: "unknown_ref"; ref: string }
  /** Not an agent: unknown, a person, reserved or a channel. `name` is the resolved handle, else the argument without its `@`. */
  | { kind: "not_agent"; name: string };

/** `resolveArg` for a tool that names an agent: the agent's row (by id, fresh), or why it isn't one. */
export async function resolveAgentArg(tx: Tx, raw: string): Promise<AgentArg> {
  const r = await resolveArg(tx, raw);
  if (r.kind === "unknown_ref") return r;
  if (r.kind === "principal" && r.p.kind === "agent") {
    const [row] = await tx.select().from(schema.agents).where(eq(schema.agents.id, r.p.id));
    if (row)
      return {
        kind: "agent",
        row,
        handle: r.p.handle,
        ...(r.warning ? { warning: r.warning } : {}),
      };
  }
  return {
    kind: "not_agent",
    name: r.kind === "principal" ? r.p.handle : raw.trim().replace(/^@/, ""),
  };
}
