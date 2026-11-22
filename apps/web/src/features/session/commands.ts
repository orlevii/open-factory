import {
  type AgentCommandsResponse,
  agentCommandsResponseSchema,
  apiFetch,
  type Command,
  queueItemResponseSchema,
} from "@open-factory/shared";
import { hashKey, type QueryClient, queryOptions, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { CommandMode, CompletionItem, CompletionSource } from "@/components/composer/composer";
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

/** `POST /api/agents/:slug/commands`: the chosen allowed entry's name and the args as data; the server
 *  builds the raw line from its own entry, never from this text (U3 §13.3). */
export const postCommand = (
  slug: string,
  body: { name: string; args: string; clientMessageId: string },
) =>
  apiFetch(`/api/agents/${encodeURIComponent(slug)}/commands`, {
    method: "POST",
    body,
    schema: queueItemResponseSchema,
  }).then((r) => r.item);

export const EMPTY_COMMANDS = "No commands loaded yet. They appear after the agent starts.";
export const FROM_TEMPLATE = "From template";
export const NOT_A_COMMAND = "Not a command for this agent; sends as text";
export const SENDS_AS_TEXT = "Sends as text; the agent may still run a skill by that name";
/** The session's `/` button label. */
export const SLASH_LABEL = "Run a command";
const staleNote = (at: string) =>
  `Commands as of ${formatTime(at)}; updates when the agent next starts`;

/** The whole text is one `/` token on one line (`//` is an escape, never a command). */
const SLASH_TOKEN = /^\/(?!\/)(\S*)$/;
/** An exact name followed by one space: command mode (U3 §13.3). */
const NAME_AND_SPACE = /^\/(\S+) $/;
/** `//` then a name: sent as text with one `/`. One line only, so a pasted `// comment` or code is
 *  never touched. */
const ESCAPED = /^\/\/[^\s/][^\n]*$/;

/** Where the `/` menu opens: only when the text is a single `/` token, with the caret in it. */
export function slashOpensAt(text: string, caret: number) {
  if (caret < 1) return undefined;
  const m = SLASH_TOKEN.exec(text);
  return m ? { query: m[1] ?? "", from: 0 } : undefined;
}

/** `//x` → `/x` (U3 §13.3); any other text is returned as it is. */
export const unescapeSlash = (text: string) => (ESCAPED.test(text) ? text.slice(1) : text);

/** A skill's description ends in its source tag ("(project)", "(plugin)"…), which the row leaves out. */
const SOURCE_TAG = /\s*\((?:project|plugin|personal|user|workflow|dynamic workflow)[^)]*\)\s*$/i;

/** The built-ins that run a factory flow (Compact), not a raw command. */
const FACTORY = new Set(["compact", "clear"]);

export type RankedCommand = {
  command: Command;
  /** The alias the query matched, when it didn't match the name. */
  alias?: string;
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
    if (!q || name === q) {
      rows.push({ r: { command, prefix: true }, tier: 0 });
      continue;
    }
    if (name.startsWith(q) || tail.startsWith(q)) {
      rows.push({ r: { command, prefix: true }, tier: 1 });
      continue;
    }
    const alias = command.aliases?.find((a) => a.toLowerCase().startsWith(q));
    if (alias) {
      rows.push({ r: { command, alias, prefix: true }, tier: alias.toLowerCase() === q ? 0 : 1 });
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

const toItem = ({ command: c, alias, prefix }: RankedCommand): CompletionItem => ({
  id: c.name,
  label: `/${c.name}`,
  group: group(c),
  kind: "command",
  exact: prefix,
  ...(c.argumentHint ? { hint: c.argumentHint } : {}),
  ...(c.description ? { detail: c.description.replace(SOURCE_TAG, "") } : {}),
  ...(alias ? { alias: `alias: ${alias}` } : {}),
});

const modeOf = (c: Command): CommandMode => ({ name: c.name, placeholder: c.argumentHint });

/**
 * The `/` source over the query cache (review notes M3, m11): `items(query)` reads the commands list
 * already cached (prefetched when the session opened) and runs only while the menu is open. The list
 * is the server's allowed set; accepting a row enters command mode with that entry's own name, which
 * is what the composer dispatches (never the typed text).
 */
export function commandSource(qc: QueryClient, slug: string): CompletionSource {
  const key = commandsQueryOptions(slug).queryKey;
  const read = () => qc.getQueryData<AgentCommandsResponse>(key);
  return {
    trigger: "/",
    label: SLASH_LABEL,
    opensAt: slashOpensAt,
    items: (query) => rankCommands(query, read()?.commands ?? []).map(toItem),
    enterNeedsExact: true,
    accept: (item) => {
      const c = read()?.commands.find((x) => x.name === item.id);
      return { text: "", caret: 0, command: c ? modeOf(c) : { name: item.id, placeholder: "" } };
    },
    commandFor(text) {
      const m = NAME_AND_SPACE.exec(text);
      if (!m) return undefined;
      const typed = m[1];
      const c = read()?.commands.find((x) => x.name === typed || x.aliases?.includes(typed ?? ""));
      return c ? modeOf(c) : undefined;
    },
    menuNote(rows) {
      const data = read();
      if (!data) return undefined;
      if (data.commands.length === 0) return EMPTY_COMMANDS;
      if (rows === 0) return undefined;
      if (data.stale && data.at) return staleNote(data.at);
      return data.source === "template" ? FROM_TEMPLATE : undefined;
    },
    missNote: () => (read()?.commands.length ? NOT_A_COMMAND : undefined),
    textNote: (text) => (ESCAPED.test(text) ? SENDS_AS_TEXT : undefined),
    // While the menu is open: the list loads if the prefetch hasn't (or is stale), and its arrival
    // re-reads the rows without a keystroke.
    watch(onChange) {
      void qc.prefetchQuery(commandsQueryOptions(slug));
      const hash = hashKey(key);
      return qc.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.action.type === "success" && e.query.queryHash === hash)
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
