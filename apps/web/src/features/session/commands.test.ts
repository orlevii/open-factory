import type { AgentCommandsResponse, Command } from "@open-factory/shared";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import {
  COMMANDS_FAILED,
  commandSource,
  commandsQueryOptions,
  EMPTY_COMMANDS,
  FROM_TEMPLATE,
  NOT_A_COMMAND,
  rankCommands,
  SENDS_AS_TEXT,
  slashOpensAt,
  unescapeSlash,
} from "./commands";

const cmd = (name: string, o: Partial<Command> = {}): Command => ({
  name,
  description: "",
  argumentHint: "",
  ...o,
});

const LIST: Command[] = [
  cmd("context", { description: "Show current context usage", builtin: true }),
  cmd("usage", { description: "Show plan usage", builtin: true, aliases: ["cost", "stats"] }),
  cmd("code-review", {
    description: "Review the current diff",
    argumentHint: "[low|medium|high] [<target>]",
    builtin: true,
    aliases: ["review"],
  }),
  cmd("compact", { description: "Free up room by summarizing", builtin: true }),
  cmd("deploy", { description: "Ship the app to staging (project)" }),
  cmd("acme:lint-all", { description: "Lint the repo, then review the context (plugin)" }),
];

let qc: QueryClient;
const respond = (over: Partial<AgentCommandsResponse> = {}) =>
  qc.setQueryData(commandsQueryOptions("dev").queryKey, {
    commands: LIST,
    source: "session",
    at: "2026-11-21T10:00:00.000Z",
    stale: false,
    ...over,
  });
beforeEach(() => {
  qc = new QueryClient();
});

test("opens only for a single `/` token on one line", () => {
  expect(slashOpensAt("/", 1)).toEqual({ query: "", from: 0 });
  expect(slashOpensAt("/co", 3)).toEqual({ query: "co", from: 0 });
  expect(slashOpensAt("/acme:lint", 10)).toEqual({ query: "acme:lint", from: 0 });
  for (const t of ["hi /co", "/co x", "/co\n", "/co\nmore", "//co", " /co", "/co "])
    expect(slashOpensAt(t, t.length)).toBeUndefined();
  // The caret before the `/` isn't in the token.
  expect(slashOpensAt("/co", 0)).toBeUndefined();
});

test("name matches rank above every description match; an exact name first", () => {
  const names = (q: string) => rankCommands(q, LIST).map((r) => r.command.name);
  // "context" is a name; "compact" and "acme:lint-all" only say it in their descriptions.
  expect(names("context")).toEqual(["context", "acme:lint-all"]);
  // "usage" by its alias "cost"; "acme:lint-all" only by its description.
  expect(names("co")).toEqual(["code-review", "compact", "context", "usage", "acme:lint-all"]);
  // The part after a plugin's `:` counts as the name.
  expect(names("lint")[0]).toBe("acme:lint-all");
  expect(rankCommands("lint", LIST)[0]?.prefix).toBe(true);
  // A description-only match is never a name-prefix one.
  expect(rankCommands("review", LIST).find((r) => r.command.name === "acme:lint-all")?.prefix).toBe(
    false,
  );
});

test("aliases match and name themselves on the canonical row", () => {
  const [hit] = rankCommands("cost", LIST);
  expect(hit?.command.name).toBe("usage");
  expect(hit?.alias).toBe("cost");
  expect(hit?.prefix).toBe(true);
});

test("rows: `/name`, the argument hint, the description without its source tag, the alias", () => {
  respond();
  const src = commandSource(qc, "dev");
  const [review] = src.items("rev");
  expect(review).toMatchObject({
    id: "code-review",
    label: "/code-review",
    hint: "[low|medium|high] [<target>]",
    detail: "Review the current diff",
    alias: "alias: review",
    exact: true,
    kind: "command",
  });
  expect(src.items("deploy")[0]?.detail).toBe("Ship the app to staging");
  expect(src.items("deploy")[0]?.group).toBe("Skills");
  expect(src.items("context")[0]?.group).toBe("Commands");
  expect(src.items("compact")[0]?.group).toBe("Factory");
});

test("accepting a row enters command mode with its argument hint as the placeholder", () => {
  respond();
  const src = commandSource(qc, "dev");
  const [review] = src.items("code");
  expect(review && src.accept(review, "/code", 0, 5)).toEqual({
    text: "",
    caret: 0,
    command: { name: "code-review", placeholder: "[low|medium|high] [<target>]" },
  });
});

test("an exact name or alias and a space enter command mode; anything else doesn't", () => {
  respond();
  const src = commandSource(qc, "dev");
  expect(src.commandFor?.("/context ")).toEqual({ name: "context", placeholder: "" });
  expect(src.commandFor?.("/cost ")).toMatchObject({ name: "usage" });
  expect(src.commandFor?.("/model ")).toBeUndefined();
  expect(src.commandFor?.("/context")).toBeUndefined();
  expect(src.commandFor?.("/context x")).toBeUndefined();
});

test("menu notes: the empty state, From template, Commands as of …", () => {
  const src = commandSource(qc, "dev");
  // Not loaded yet: nothing to say.
  expect(src.menuNote?.(0)).toBeUndefined();
  respond({ commands: [], source: "template", at: null });
  expect(src.menuNote?.(0)).toBe(EMPTY_COMMANDS);
  expect(EMPTY_COMMANDS).toBe("No commands loaded yet. They appear after the agent starts.");
  respond({ source: "template", at: null });
  expect(src.menuNote?.(3)).toBe(FROM_TEMPLATE);
  expect(FROM_TEMPLATE).toBe("From template");
  // No rows match: the menu closes, so there is no note.
  expect(src.menuNote?.(0)).toBeUndefined();
  respond({ stale: true, at: new Date(2026, 10, 21, 9, 5).toISOString() });
  expect(src.menuNote?.(2)).toBe("Commands as of 09:05; updates when the agent next starts");
  respond();
  expect(src.menuNote?.(2)).toBeUndefined();
});

test("a typed `/foo` that matches nothing says it sends as text; only once the list loaded", () => {
  const src = commandSource(qc, "dev");
  expect(src.missNote?.()).toBeUndefined();
  respond();
  expect(src.missNote?.()).toBe(NOT_A_COMMAND);
  expect(NOT_A_COMMAND).toBe("Not a command for this agent; sends as text");
});

test("`//x` says it sends as text, and sends with one `/`", () => {
  const src = commandSource(qc, "dev");
  expect(src.textNote?.("//deploy now")).toBe(SENDS_AS_TEXT);
  expect(SENDS_AS_TEXT).toBe("Sends as text; the agent may still run a skill by that name");
  for (const t of ["/deploy", "// a comment", "hi //x", "///"])
    expect(src.textNote?.(t)).toBeUndefined();
  expect(unescapeSlash("//deploy now")).toBe("/deploy now");
  // A pasted comment or multi-line text is left alone.
  expect(unescapeSlash("// a comment")).toBe("// a comment");
  expect(unescapeSlash("//x\nmore")).toBe("//x\nmore");
  expect(unescapeSlash("/x")).toBe("/x");
});

test("watch loads the list once and reports when it changes", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ commands: LIST, source: "session", at: null, stale: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  const stop = commandSource(qc, "dev").watch?.(onChange);
  await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/agents/dev/commands");
  stop?.();
  vi.unstubAllGlobals();
});

test("a list that failed to load says so in the menu", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
  await qc.prefetchQuery({ ...commandsQueryOptions("dev"), retry: false });
  const src = commandSource(qc, "dev");
  expect(COMMANDS_FAILED).toBe("Couldn't load this agent's commands.");
  expect(src.menuNote?.(0)).toBe(COMMANDS_FAILED);
  expect(src.missNote?.()).toBeUndefined();
  vi.unstubAllGlobals();
});

test("browsing (`/` alone) groups the rows Skills, Commands, Factory, each headed once; a query ranks flat", () => {
  respond();
  const src = commandSource(qc, "dev");
  const all = src.items("");
  expect(all.map((i) => i.group)).toEqual([
    "Skills",
    "Skills",
    "Commands",
    "Commands",
    "Commands",
    "Factory",
  ]);
  expect(all.filter((i) => i.heading).map((i) => [i.heading, i.id])).toEqual([
    ["Skills", "acme:lint-all"],
    ["Commands", "code-review"],
    ["Factory", "compact"],
  ]);
  expect(src.items("co").some((i) => i.heading)).toBe(false);
});

test("ready: undecided until the list has loaded or failed; watch hears a failure too", async () => {
  const src = commandSource(qc, "dev");
  expect(src.ready?.()).toBe(false);
  const heard = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "x", message: "no" } }), { status: 500 }),
    ),
  );
  const stop = src.watch?.(heard);
  await vi.waitFor(() => expect(heard).toHaveBeenCalled());
  expect(src.ready?.()).toBe(true);
  stop?.();
  vi.unstubAllGlobals();
  respond();
  expect(src.ready?.()).toBe(true);
});
