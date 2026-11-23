import type { AgentCommandsResponse, Command } from "@open-factory/shared";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vitest";
import {
  COMMANDS_FAILED,
  commandSource,
  commandsQueryOptions,
  EMPTY_COMMANDS,
  FROM_TEMPLATE,
  invalidateCommands,
  ONE_LINE,
  rankCommands,
  slashOpensAt,
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
  for (const t of ["hi /co", "/co x", "/co\n", "/co\nmore", " /co", "/co "])
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
    kind: "command",
  });
  expect(src.items("deploy")[0]?.detail).toBe("Ship the app to staging");
  expect(src.items("deploy")[0]?.group).toBe("Skills");
  expect(src.items("context")[0]?.group).toBe("Commands");
  expect(src.items("compact")[0]?.group).toBe("Factory");
});

test("accepting a row inserts `/name ` and puts the caret after it; nothing else", () => {
  respond();
  const src = commandSource(qc, "dev");
  const [review] = src.items("code");
  expect(review && src.accept(review, "/code", 0, 5)).toEqual({
    text: "/code-review ",
    caret: 13,
  });
});

test("Enter sends a name or alias typed in full, and text that matched only part of a name or a description", () => {
  respond();
  const src = commandSource(qc, "dev");
  expect(src.items("context")[0]?.enterSends).toBe(true);
  expect(src.items("cost")[0]).toMatchObject({ id: "usage", enterSends: true });
  expect(src.items("con")[0]?.enterSends).toBeUndefined(); // a prefix: Enter accepts it
  expect(src.items("diff")[0]?.enterSends).toBe(true); // a description match
});

test("denied names show only when typed in full, disabled with their reason", () => {
  const reason = "/clear isn't available: each agent keeps one session.";
  respond({
    commands: [...LIST, cmd("clear", { builtin: true, denied: reason, aliases: ["reset"] })],
  });
  const src = commandSource(qc, "dev");
  expect(src.items("").some((i) => i.id === "clear")).toBe(false);
  expect(src.items("cle").some((i) => i.id === "clear")).toBe(false);
  expect(src.items("clear")[0]).toMatchObject({ id: "clear", disabled: reason, detail: reason });
  expect(src.items("reset")[0]).toMatchObject({ id: "clear", disabled: reason });
});

test("a denied first token is refused with the denylist's reason once it is complete", () => {
  const src = commandSource(qc, "dev");
  const refusal = (reason: string) => ({ kind: "refusal", text: reason });
  expect(src.textNote?.("/clear ")).toEqual(
    refusal("/clear isn't available: each agent keeps one session."),
  );
  expect(src.textNote?.("  /Model gpt")).toEqual(
    refusal("/Model isn't available: the model and effort come from the agent's template."),
  );
  expect(src.textNote?.("/resume\nmore")).toEqual(
    refusal("/resume isn't available: the factory runs this agent's process."),
  );
  // Still being typed: nothing, until Enter.
  expect(src.textNote?.("/clear")).toBeUndefined();
  expect(src.textNote?.("/logout", true)).toEqual(
    refusal("/logout isn't available: credentials are managed in Settings \u2192 Credentials."),
  );
  // Anything else, a path and an unknown skill included, shows nothing.
  for (const t of ["/news-digest ", "/Users/or/log.txt ", "//clear ", "hi /clear ", "/", "clear "])
    expect(src.textNote?.(t, true)).toBeUndefined();
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

test("watch hears a failed load too", async () => {
  const src = commandSource(qc, "dev");
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
  stop?.();
  vi.unstubAllGlobals();
});

test("agent_commands_changed invalidates that agent's list only", () => {
  const spy = vi.spyOn(qc, "invalidateQueries");
  invalidateCommands(qc, { type: "agent_commands_changed", agent: "dev" });
  expect(spy).toHaveBeenCalledWith({ queryKey: ["agent-commands", "dev"] });
  invalidateCommands(qc, { type: "agent_status", agent: "dev" } as never);
  expect(spy).toHaveBeenCalledTimes(1);
});

test("an open menu fetches the list again when the agent starts", async () => {
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      n++;
      return new Response(
        JSON.stringify({
          commands: n === 1 ? [] : LIST,
          source: "session",
          at: null,
          stale: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  const src = commandSource(qc, "dev");
  const onChange = vi.fn();
  const stop = src.watch?.(onChange);
  await vi.waitFor(() => expect(src.items("").length).toBe(0));
  await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
  invalidateCommands(qc, { type: "agent_commands_changed", agent: "dev" });
  await vi.waitFor(() => expect(src.items("").length).toBeGreaterThan(0));
  expect(n).toBe(2);
  stop?.();
  vi.unstubAllGlobals();
});

test("an invalidation cancels a fetch under way, so the old list never wins", async () => {
  const held: ((r: Response) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          held.push(resolve);
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("x", "AbortError")),
          );
        }),
    ),
  );
  const body = (commands: Command[]) =>
    new Response(JSON.stringify({ commands, source: "session", at: null, stale: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const src = commandSource(qc, "dev");
  const stop = src.watch?.(() => {});
  await vi.waitFor(() => expect(held).toHaveLength(1)); // the menu's GET, held open
  invalidateCommands(qc, { type: "agent_commands_changed", agent: "dev" });
  await vi.waitFor(() => expect(held).toHaveLength(2));
  held[0]?.(body([cmd("old")])); // answered before the start: too late
  held[1]?.(body([cmd("fresh")]));
  await vi.waitFor(() => expect(src.items("").map((i) => i.id)).toEqual(["fresh"]));
  stop?.();
  vi.unstubAllGlobals();
});

test("a known command over several lines is refused before sending; unknown text and compact", () => {
  respond();
  const src = commandSource(qc, "dev");
  expect(src.textNote?.("/context\nfoo")).toEqual({ kind: "refusal", text: ONE_LINE });
  expect(src.textNote?.("/COST\u2028x")).toEqual({ kind: "refusal", text: ONE_LINE });
  expect(src.textNote?.("/compact\nfocus")).toEqual({ kind: "refusal", text: ONE_LINE });
  // A trailing newline is trimmed, an unknown token is text.
  expect(src.textNote?.("/context\n")).toBeUndefined();
  expect(src.textNote?.("/Users/or/log.txt\nx")).toBeUndefined();
  // Before the list loads nothing is known; the server still refuses.
  qc.clear();
  expect(commandSource(qc, "dev").textNote?.("/context\nfoo")).toBeUndefined();
});
