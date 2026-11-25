import { ENV_NAME } from "@open-factory/shared";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";
import { isRec } from "./tolerant";

/**
 * One MCP server entry, read and written by the form (spec §12.2). A row shows only the name, the kind and a summary
 * (a plain program name and an argument count, or the URL's host): never the args, the full URL, a header or an env
 * value, because tokens hide in them.
 */

export type ServerKind = "command" | "url";
export type Pair = { id: number; name: string; value: string };
export type ServerDraft = {
  name: string;
  kind: ServerKind;
  command: string;
  /** One argument per line. */
  args: string;
  env: Pair[];
  url: string;
  headers: Pair[];
  /** The entry's other keys (`timeout`, `type: "stdio"`, …), kept on save. */
  rest: Record<string, unknown>;
  /** The URL transport the entry had: any string `type` but `stdio` is kept as it is (`sse`, a newer one, a typo). */
  urlType: string;
};

const OWNED = new Set(["command", "args", "env", "url", "headers", "type"]);
/** A command shown in a row: a bare program name (`npx`, `uvx`, `docker`). Anything else reads "Command". */
const PROGRAM = /^[A-Za-z0-9._+-]{1,32}$/;
/** Token prefixes a bare "program" must not start with: a token pasted as the command is never shown (review M1). */
const TOKEN_PREFIX = /^(?:sk-|ghp_|gho_|github_pat_|xox)/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const HTTP_URL = /^https?:\/\/\S+$/i;
/** A host a row may show: DNS labels or an IP. A `${VAR}` host (percent-encoded by URL) is not shown. */
const HOST = /^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/;

export const serverKind = (entry: Record<string, unknown>): ServerKind =>
  typeof entry.url === "string" || entry.type === "http" || entry.type === "sse"
    ? "url"
    : "command";

const isStringRecord = (v: unknown): v is Record<string, string> =>
  isRec(v) && Object.values(v).every((x) => typeof x === "string");

/** True when the form can edit this entry; anything else is edited in Raw JSON. */
export function isFormShaped(entry: unknown): entry is Record<string, unknown> {
  if (!isRec(entry)) return false;
  const { command, args, env, url, headers } = entry;
  if (command !== undefined && typeof command !== "string") return false;
  if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string")))
    return false;
  if (env !== undefined && !isStringRecord(env)) return false;
  if (url !== undefined && typeof url !== "string") return false;
  if (headers !== undefined && !isStringRecord(headers)) return false;
  return true;
}

/** Line 2 of a row: "npx · 3 args", or the URL's host. Never an argument, a path, a URL's path or its userinfo. */
export function serverSummary(entry: Record<string, unknown>): string {
  if (serverKind(entry) === "url") {
    const url = typeof entry.url === "string" ? entry.url : "";
    try {
      const u = new URL(url);
      if ((u.protocol === "http:" || u.protocol === "https:") && HOST.test(u.hostname))
        return u.hostname;
    } catch {
      // A URL with a ${VAR} host, or none: say so rather than show it.
    }
    return CONFIG_COPY.urlUnreadable;
  }
  const command = typeof entry.command === "string" ? entry.command : "";
  const base = command.split(/[\\/]/).pop() ?? "";
  const program = PROGRAM.test(base) && !TOKEN_PREFIX.test(base) ? base : CONFIG_COPY.kindCommand;
  const n = Array.isArray(entry.args) ? entry.args.length : 0;
  return n === 0 ? program : `${program} · ${n} ${n === 1 ? "arg" : "args"}`;
}

let nextPairId = 1;
const pairs = (rec: unknown): Pair[] =>
  isStringRecord(rec)
    ? Object.entries(rec).map(([name, value]) => ({ id: nextPairId++, name, value }))
    : [];
export const newPair = (): Pair => ({ id: nextPairId++, name: "", value: "" });

export function toDraft(name: string, entry: Record<string, unknown> | undefined): ServerDraft {
  const e = entry ?? {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (!OWNED.has(k)) rest[k] = v;
  if (e.type === "stdio") rest.type = "stdio";
  return {
    name,
    kind: entry ? serverKind(e) : "command",
    command: typeof e.command === "string" ? e.command : "",
    args: Array.isArray(e.args) ? e.args.join("\n") : "",
    env: pairs(e.env),
    url: typeof e.url === "string" ? e.url : "",
    headers: pairs(e.headers),
    rest,
    urlType: typeof e.type === "string" && e.type !== "stdio" ? e.type : "http",
  };
}

const record = (ps: readonly Pair[]): Record<string, string> | undefined => {
  const kept = ps.filter((p) => p.name.trim() !== "" || p.value !== "");
  return kept.length === 0
    ? undefined
    : Object.fromEntries(kept.map((p) => [p.name.trim(), p.value]));
};

/** The entry a draft saves: only the chosen kind's fields; the other kind's typed fields are dropped here. */
export function fromDraft(d: ServerDraft): Record<string, unknown> {
  if (d.kind === "url") {
    const { type: _stdio, ...rest } = d.rest;
    const headers = record(d.headers);
    return { ...rest, type: d.urlType, url: d.url.trim(), ...(headers ? { headers } : {}) };
  }
  const args = d.args
    .split("\n")
    .map((a) => a.replace(/\r$/, ""))
    .filter((a) => a !== "");
  const env = record(d.env);
  return {
    ...d.rest,
    command: d.command.trim(),
    ...(args.length > 0 ? { args } : {}),
    ...(env ? { env } : {}),
  };
}

export type EditorField = "mcp-name" | "mcp-command" | "mcp-url";

export function checkName(name: string, taken: ReadonlySet<string>): string | undefined {
  const n = name.trim();
  if (!n) return CONFIG_FIELD_MSG.enterName;
  if (n === "factory") return CONFIG_FIELD_MSG.factoryServer;
  if (taken.has(n)) return CONFIG_FIELD_MSG.duplicate;
  return undefined;
}

export function checkUrl(url: string): string | undefined {
  const u = url.trim();
  if (!u) return CONFIG_FIELD_MSG.enterUrl;
  return HTTP_URL.test(u) ? undefined : CONFIG_FIELD_MSG.urlScheme;
}

/** A pair's name: env names follow ENV_NAME; header names are HTTP tokens. A blank pair is dropped, not an error. */
export function checkPairName(kind: "env" | "header", p: Pair): string | undefined {
  const n = p.name.trim();
  if (!n) return p.value === "" ? undefined : CONFIG_FIELD_MSG.enterName;
  if (kind === "env") return ENV_NAME.test(n) ? undefined : CONFIG_FIELD_MSG.envName;
  return HEADER_NAME.test(n) ? undefined : CONFIG_FIELD_MSG.headerName;
}

/** Every pair's name error, by pair id: its own rule, then a repeated name (the later one is flagged). */
export function pairErrors(kind: "env" | "header", ps: readonly Pair[]): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Set<string>();
  for (const p of ps) {
    const own = checkPairName(kind, p);
    const n = p.name.trim();
    if (own) out.set(p.id, own);
    else if (n && seen.has(n)) out.set(p.id, CONFIG_FIELD_MSG.duplicate);
    if (n) seen.add(n);
  }
  return out;
}
