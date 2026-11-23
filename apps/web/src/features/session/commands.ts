import {
  type AgentCommandsResponse,
  agentCommandsResponseSchema,
  apiFetch,
  type Command,
  classifyInput,
  deniedReason,
  type ServerMessage,
} from "@open-factory/shared";
import { hashKey, type QueryClient, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CompletionItem, CompletionSource } from "@/components/composer/composer";
import { formatTime } from "./format";

/** The list changes only when the agent's process starts, so an opening menu refreshes it at most this often. */
const COMMANDS_STALE_MS = 30_000;

/** `GET /api/agents/:slug/commands` (U3 §13.3): the allowed set, prefetched when the session opens (m11). */
export const commandsQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ["agent-commands", slug],
    queryFn: ({ signal }) =>
      apiFetch(`/api/agents/${encodeURIComponent(slug)}/commands`, {
        schema: agentCommandsResponseSchema,
        signal,
      }),
    staleTime: COMMANDS_STALE_MS,
  });

/** The agent started, so its command list changed (I1 §6): the cached list is stale, and a menu that
 *  is open (`watch`) fetches it again. Called from the socket's global handler, so a closed menu costs
 *  nothing and the session's own reducer never sees the frame. */
export function invalidateCommands(qc: QueryClient, m: ServerMessage): void {
  if (m.type !== "agent_commands_changed") return;
  const filters = { queryKey: ["agent-commands", m.agent] };
  const invalidate = () => void qc.invalidateQueries(filters);
  // A fetch under way (a menu opened just before the start) was answered with the old list, and its
  // arrival would reset the invalidation: cancel it first, so the invalidation fetches again.
  if (qc.isFetching(filters)) void qc.cancelQueries(filters).then(invalidate);
  else invalidate();
}

/** The lowercase names and aliases of a list, built once per data object (a refetch makes a new one). */
const knownByData = new WeakMap<AgentCommandsResponse, ReadonlySet<string>>();
function knownNames(data: AgentCommandsResponse): ReadonlySet<string> {
  let known = knownByData.get(data);
  if (!known) {
    known = new Set(
      data.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())),
    );
    knownByData.set(data, known);
  }
  return known;
}

/** Whether `name` is a command of this agent's list (or an alias); true while the list hasn't loaded,
 *  since nothing says it isn't (the chat's note for a leading `/`). */
export function knownCommand(qc: QueryClient, slug: string, name: string): boolean {
  const data = qc.getQueryData<AgentCommandsResponse>(commandsQueryOptions(slug).queryKey);
  return !data || knownNames(data).has(name.toLowerCase());
}

/** A command with more lines: refused in the slot, as the server would. */
export const ONE_LINE = "A command must be one line.";
export const EMPTY_COMMANDS = "No commands loaded yet. They appear after the agent starts.";
export const FROM_TEMPLATE = "From template";
/** The list couldn't be fetched: said in the menu, rather than a menu that never opens. */
export const COMMANDS_FAILED = "Couldn't load this agent's commands.";
/** The session's `/` button label. */
export const SLASH_LABEL = "Run a command";
const staleNote = (at: string) =>
  `Commands as of ${formatTime(at)}; updates when the agent next starts`;

/** The whole text is one `/` token on one line. */
const SLASH_TOKEN = /^\/(\S*)$/;
/** A leading `/token` and what ends it: whitespace, or the end of the text. */
const FIRST_TOKEN = /^\s*\/(\S+)(\s|$)/;

/** Where the `/` menu opens: only when the text is a single `/` token, with the caret in it. */
export function slashOpensAt(text: string, caret: number) {
  if (caret < 1) return undefined;
  const m = SLASH_TOKEN.exec(text);
  return m ? { query: m[1] ?? "", from: 0 } : undefined;
}

/** A skill's description ends in its source tag ("(project)", "(plugin)"…), which the row leaves out. */
const SOURCE_TAG = /\s*\((?:project|plugin|personal|user|workflow|dynamic workflow)[^)]*\)\s*$/i;

/** The built-ins that run a factory flow (Compact), not a raw command. */
const FACTORY = new Set(["compact"]);

export type RankedCommand = {
  command: Command;
  /** The alias the query matched, when it didn't match the name. */
  alias?: string;
  /** The query is this name or alias in full: Enter then sends the text as typed. */
  exact?: boolean;
  /** A name-prefix or exact match (of the name, the part after a plugin's `:`, or an alias): the only
   *  rows Enter accepts. */
  prefix: boolean;
};

/**
 * U3 §13.3: name matches above every description match. Tiers: an exact name or alias, a name-prefix
 * (or the part after `:`, or an alias prefix), the name containing the query, then the description
 * containing it. Alphabetical within a tier. An empty query lists everything.
 */
export function rankCommands(query: string, commands: readonly Command[]): RankedCommand[] {
  const q = query.toLowerCase();
  const rows: { r: RankedCommand; tier: number }[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const tail = name.slice(name.lastIndexOf(":") + 1);
    const isExact =
      q !== "" && (name === q || !!command.aliases?.some((a) => a.toLowerCase() === q));
    // A denied name shows only when it is typed in full, as a disabled row with its reason.
    if (command.denied !== undefined && !isExact) continue;
    if (!q || name === q) {
      rows.push({ r: { command, prefix: true, ...(isExact ? { exact: true } : {}) }, tier: 0 });
      continue;
    }
    if (name.startsWith(q) || tail.startsWith(q)) {
      rows.push({ r: { command, prefix: true }, tier: 1 });
      continue;
    }
    const alias = command.aliases?.find((a) => a.toLowerCase().startsWith(q));
    if (alias) {
      rows.push({
        r: { command, alias, prefix: true, ...(isExact ? { exact: true } : {}) },
        tier: alias.toLowerCase() === q ? 0 : 1,
      });
      continue;
    }
    if (name.includes(q)) rows.push({ r: { command, prefix: false }, tier: 2 });
    else if (command.description.toLowerCase().includes(q))
      rows.push({ r: { command, prefix: false }, tier: 3 });
  }
  rows.sort((a, b) => a.tier - b.tier || a.r.command.name.localeCompare(b.r.command.name));
  return rows.map((x) => x.r);
}

const group = (c: Command) =>
  !c.builtin ? "Skills" : FACTORY.has(c.name) ? "Factory" : "Commands";
const GROUP_ORDER = ["Skills", "Commands", "Factory"];

/** Browsing (`/` alone): the rows by group (U3 §13.3), each group's first row carrying its heading. A
 *  typed query keeps the flat ranking, so the best name match stays first for Enter. */
function grouped(items: CompletionItem[]): CompletionItem[] {
  const out = items.toSorted((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  return out.map((it, i) =>
    i === 0 || out[i - 1]?.group !== it.group ? { ...it, heading: it.group } : it,
  );
}

const toItem = ({ command: c, alias, prefix, exact }: RankedCommand): CompletionItem => ({
  id: c.name,
  label: `/${c.name}`,
  group: group(c),
  kind: "command",
  // Enter sends a name typed in full, and text that only matched a description or part of a name.
  ...(exact || !prefix ? { enterSends: true } : {}),
  ...(c.denied !== undefined
    ? { disabled: c.denied, detail: c.denied }
    : c.description
      ? { detail: c.description.replace(SOURCE_TAG, "") }
      : {}),
  ...(c.argumentHint ? { hint: c.argumentHint } : {}),
  ...(alias ? { alias: `alias: ${alias}` } : {}),
});

/**
 * The `/` source over the query cache (review notes M3, m11): `items(query)` reads the commands list
 * already cached (prefetched when the session opened) and runs only while the menu is open. The list
 * is the server's list, for autocomplete only: accepting a row inserts `/name `, and everything sent
 * goes to `/input` as typed.
 */
export function commandSource(qc: QueryClient, slug: string): CompletionSource {
  const key = commandsQueryOptions(slug).queryKey;
  const read = () => qc.getQueryData<AgentCommandsResponse>(key);
  return {
    trigger: "/",
    label: SLASH_LABEL,
    opensAt: slashOpensAt,
    items: (query) => {
      const rows = rankCommands(query, read()?.commands ?? []).map(toItem);
      return query === "" ? grouped(rows) : rows;
    },
    allRows: true,
    accept: (item, text, from, caret) => {
      const insert = `/${item.id} `;
      return {
        text: text.slice(0, from) + insert + text.slice(caret),
        caret: from + insert.length,
      };
    },
    menuNote(rows) {
      const data = read();
      if (!data) return qc.getQueryState(key)?.status === "error" ? COMMANDS_FAILED : undefined;
      if (data.commands.length === 0) return EMPTY_COMMANDS;
      if (rows === 0) return undefined;
      if (data.stale && data.at) return staleNote(data.at);
      return data.source === "template" ? FROM_TEMPLATE : undefined;
    },
    // A denied command is refused once its first token is complete (whitespace typed, or Enter),
    // with the denylist's own reason; the server refuses it too.
    textNote(text, sending) {
      const m = FIRST_TOKEN.exec(text);
      if (!m?.[1] || (m[2] === "" && !sending)) return undefined;
      const reason = deniedReason(m[1]);
      if (reason) return { kind: "refusal", text: reason };
      // The server's rule, before sending: one command is one line (a trailing newline is trimmed).
      const data = read();
      if (data) {
        const cls = classifyInput(text.trimEnd(), knownNames(data));
        if (cls.kind === "command" && cls.multiline) return { kind: "refusal", text: ONE_LINE };
      }
      return undefined;
    },
    // While the menu is open: the list loads if the prefetch hasn't (or is stale), an invalidation
    // (the agent started) fetches it again, and its arrival re-reads the rows without a keystroke.
    watch(onChange) {
      void qc.prefetchQuery(commandsQueryOptions(slug));
      const hash = hashKey(key);
      return qc.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.action.type === "invalidate" && e.query.queryHash === hash)
          void qc.prefetchQuery(commandsQueryOptions(slug));
        // A failed GET decides too (a stored command then stays text).
        if (
          e.type === "updated" &&
          (e.action.type === "success" || e.action.type === "error") &&
          e.query.queryHash === hash
        )
          onChange();
      });
    },
  };
}

/** One `/` source per agent: identity-stable, so it never breaks the composer's `memo` (M3). */
export function useCommandSource(slug: string): CompletionSource {
  const qc = useQueryClient();
  return useMemo(() => commandSource(qc, slug), [qc, slug]);
}
