import type { AnyEvent, ServerMessage } from "@open-factory/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary, detail, envelope, resetSeq, se } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void; onOpen?: () => void }) => {
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 15, 0));
  resetSeq();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Opens /agents/lead with these events; `@tech-lead-ab12` is a live spawned agent. */
async function open(events: AnyEvent[], firstText: string | RegExp) {
  const api = mockApi({
    "GET /api/agents/lead": () => json(detail({ slug: "lead", displayName: "Lead" })),
    "GET /api/agents/lead/events?": () =>
      json({ hasMore: { before: false, after: false }, events: events.map((e) => se(e)) }),
    "GET /api/agents?ended=exclude": () =>
      json({
        agents: [
          agentSummary({ slug: "lead", displayName: "Lead" }),
          agentSummary({
            slug: "tech-lead-ab12",
            displayName: "Tech Lead · ab12",
            kind: "ephemeral",
            reportsTo: { kind: "agent", ref: "aaaaaaaa", handle: "lead" },
          }),
        ],
        running: { count: 1 },
      }),
    "GET /api/agents?ended=only": () => json({ agents: [], more: false, running: { count: 1 } }),
  });
  renderApp("/agents/lead/session", alice);
  await screen.findByText(firstText);
  return api;
}

const BRIEF = "Write the **spec** for S8.\n\nWork with `@proxy-r1`.";
const spawn = (over: Record<string, unknown> = {}, toolUseId = "toolu_s"): AnyEvent => ({
  type: "tool_call",
  toolUseId,
  name: "mcp__factory__spawn_agent",
  input: { template: "tech-lead", description: "Writes the S8 spec", prompt: BRIEF, ...over },
});
const terminate = (slug: string, toolUseId = "toolu_t"): AnyEvent => ({
  type: "tool_call",
  toolUseId,
  name: "mcp__factory__terminate_agent",
  input: { slug },
});
const result = (content: string, isError = false, toolUseId = "toolu_s"): AnyEvent => ({
  type: "tool_result",
  toolUseId,
  content,
  isError,
});
const ok = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ slug: "tech-lead-ab12", agent_id: "0f9e-secret-id", status: "idle", ...o });
const textOf = (el: Element) => el.textContent?.replace(/\s+/g, " ").trim();
/** The sender line's sentence, without its time. */
function senderOf(block: HTMLElement) {
  const line = block.firstElementChild as HTMLElement;
  expect(line.querySelector("time")).not.toBeNull();
  return textOf(line.querySelector(":scope > span") as Element);
}

test("a spawn renders as a block: GitFork sender line with the child's link and name, the description as text, the brief as Markdown, 'Spawned'", async () => {
  await open([{ type: "turn_started" }, spawn(), result(ok())], "Writes the S8 spec");
  const block = screen.getByRole("article", { name: "@lead spawned @tech-lead-ab12" });
  const sender = block.firstElementChild as HTMLElement;
  // The display name comes from the agents list, a separate query from the events.
  await vi.waitFor(() =>
    expect(senderOf(block)).toBe("@lead spawned @tech-lead-ab12 · Tech Lead · ab12"),
  );
  expect(sender.querySelector("svg.lucide-git-fork")).toHaveAttribute("aria-hidden", "true");
  expect(within(sender).getByText("@lead")).toBeInTheDocument();
  expect(within(block).getByRole("link", { name: "Open @tech-lead-ab12's chat" })).toHaveAttribute(
    "href",
    "/agents/tech-lead-ab12/chat",
  );
  // The description is plain text, the brief goes through Markdown.
  const description = within(block).getByText("Writes the S8 spec");
  expect(description.tagName).toBe("P");
  expect(within(block).getByText("spec").tagName).toBe("STRONG");
  expect(within(block).getByText("Spawned")).toBeInTheDocument();
  // Never an id.
  expect(block.textContent).not.toContain("0f9e-secret-id");
  expect(screen.queryByTitle("mcp__factory__spawn_agent")).toBeNull();
  // The raw call is in the row menu (U3 §7.5), not a footer button.
  expect(within(block).queryByRole("button", { name: "Show tool call" })).toBeNull();
  const wrap = block.closest("[data-row-wrap]") as HTMLElement;
  fireEvent.pointerDown(within(wrap).getByRole("button", { name: "Row actions" }), {
    button: 0,
    pointerType: "mouse",
  });
  await userEvent.click(await screen.findByRole("menuitem", { name: "View tool call" }));
  expect(screen.getByTitle("mcp__factory__spawn_agent")).toBeInTheDocument();
});

test("a description holding markup stays literal text", async () => {
  await open(
    [{ type: "turn_started" }, spawn({ description: "<b>bold</b> **not bold**" }), result(ok())],
    "<b>bold</b> **not bold**",
  );
  expect(document.querySelector("article b")).toBeNull();
});

test("a rate-limited spawn adds '· @x was rate-limited' and the note as written", async () => {
  await open(
    [
      { type: "turn_started" },
      spawn(),
      result(ok({ status: "rate_limited", note: "Secret GH_TOKEN wasn't passed on." })),
    ],
    "Writes the S8 spec",
  );
  const block = screen.getByRole("article", { name: "@lead spawned @tech-lead-ab12" });
  const line = within(block).getByText(
    (_, el) =>
      el?.tagName === "SPAN" && el.textContent === "Spawned · @tech-lead-ab12 was rate-limited",
  );
  expect(within(line).getByText("@tech-lead-ab12")).toBeInTheDocument();
  expect(within(block).getByText("Secret GH_TOKEN wasn't passed on.")).toBeInTheDocument();
});

test("other statuses add nothing to 'Spawned'", async () => {
  await open(
    [{ type: "turn_started" }, spawn(), result(ok({ status: "working" }))],
    "Writes the S8 spec",
  );
  expect(screen.getByText("Spawned")).toBeInTheDocument();
  expect(screen.queryByText(/was /)).toBeNull();
});

test("no result while the turn is open: 'Spawning…', the template in the sender line", async () => {
  await open([{ type: "turn_started" }, spawn()], "Writes the S8 spec");
  const block = screen.getByRole("article", { name: "@lead is spawning from tech-lead" });
  expect(senderOf(block)).toBe("@lead spawn from template tech-lead");
  expect(within(block).getByText("tech-lead")).toBeInTheDocument();
  expect(within(block).getByText("Spawning…")).toBeInTheDocument();
});

test("no result after the turn ended never says 'Not spawned'", async () => {
  await open(
    [{ type: "turn_started" }, spawn(), { type: "turn_end", isError: false, numTurns: 1 }],
    "Writes the S8 spec",
  );
  const block = screen.getByRole("article", { name: "@lead's spawn from tech-lead has no result" });
  expect(
    within(block).getByText(
      "No result: the turn ended before the spawn finished. Check the Agents list.",
    ),
  ).toBeInTheDocument();
});

test("a failed spawn shows the tool's sentence", async () => {
  await open(
    [
      { type: "turn_started" },
      spawn(),
      result("You already have 5 live spawned agents. Terminate one first.", true),
    ],
    "Writes the S8 spec",
  );
  const block = screen.getByRole("article", { name: "@lead's spawn from tech-lead failed" });
  const sentence = within(block).getByText(
    "You already have 5 live spawned agents. Terminate one first.",
  );
  expect(sentence).toBeInTheDocument();
  expect(within(block).queryByText("Spawned")).toBeNull();
  expect(senderOf(block)).toBe("@lead spawn from template tech-lead");
});

const denied = (toolUseId: string): AnyEvent => ({
  type: "permission_denied",
  toolUseId,
  toolName: "x",
  reasonType: "rule",
  reason: "Spawning isn't allowed here",
});

test("a denied spawn shows the denial sentence as a failure, never 'Spawned'", async () => {
  await open(
    [
      { type: "turn_started" },
      spawn(),
      denied("toolu_s"),
      { type: "turn_end", isError: false, numTurns: 1 },
    ],
    "Writes the S8 spec",
  );
  const block = screen.getByRole("article", { name: "@lead's spawn from tech-lead failed" });
  const sentence = within(block).getByText("Denied: Spawning isn't allowed here");
  expect(sentence).toBeInTheDocument();
  expect(within(block).queryByText("Spawned")).toBeNull();
  expect(within(block).queryByText(/No result/)).toBeNull();
});

test("a denied terminate is a quiet line with the denial sentence", async () => {
  await open(
    [
      { type: "turn_started" },
      terminate("tech-lead-ab12", "t1"),
      denied("t1"),
      { type: "turn_end", isError: false, numTurns: 1 },
    ],
    /Couldn't terminate/,
  );
  const line = screen.getByText(
    (_, el) =>
      el?.tagName === "P" &&
      textOf(el) === "Couldn't terminate @tech-lead-ab12: Denied: Spawning isn't allowed here",
  );
  expect(line).toBeInTheDocument();
});

test("malformed spawn_agent input falls back to the tool row", async () => {
  await open(
    [{ type: "turn_started" }, spawn({ prompt: 42 }), result("bad", true)],
    /^spawn_agent$/, // the tool row reads "factory · spawn_agent": the tool is its own span (U3 §9.2)
  );
  expect(screen.queryByRole("article", { name: /spawn/ })).toBeNull();
});

test("terminate_agent is one quiet line with a CircleX: done, running, failed, no result", async () => {
  await open(
    [
      { type: "turn_started" },
      terminate("tech-lead-ab12", "t1"),
      result(JSON.stringify({ slug: "tech-lead-ab12", status: "terminated" }), false, "t1"),
      terminate("nobody", "t2"),
      result("No spawned agent named @nobody. Call list_peers to see your reports.", true, "t2"),
      // A later turn ends t3 unanswered; t4 is in the open one (the fixture's events share a turn id).
      terminate("tech-lead-ab12", "t3"),
      { type: "turn_started" },
      terminate("tech-lead-ab12", "t4"),
    ],
    /Couldn't terminate/,
  );
  const done = screen.getByText(
    (_, el) => el?.tagName === "P" && textOf(el) === "Terminated @tech-lead-ab12",
  );
  expect(
    within(done).getByRole("link", { name: "Open @tech-lead-ab12's chat" }),
  ).toBeInTheDocument();
  expect(done.querySelector("svg.lucide-circle-x")).not.toBeNull();
  const failed = screen.getByText(
    (_, el) =>
      el?.tagName === "P" &&
      textOf(el) ===
        "Couldn't terminate @nobody: No spawned agent named @nobody. Call list_peers to see your reports.",
  );
  expect(failed).toBeInTheDocument();
  expect(
    screen.getByText(
      (_, el) =>
        el?.tagName === "P" &&
        textOf(el) === "No result: the turn ended before the terminate finished.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      (_, el) => el?.tagName === "P" && textOf(el) === "Terminating @tech-lead-ab12…",
    ),
  ).toBeInTheDocument();
});

test("lifecycle lines with an agent `by` link to it: spawned, terminated, peer left", async () => {
  await open(
    [
      { type: "spawned", by: "tech-lead-ab12", template: "tech-lead" },
      { type: "terminated", by: "tech-lead-ab12" },
      {
        type: "message_in",
        messages: [
          envelope({
            id: "p1",
            from: "@factory",
            fromKind: "factory",
            kind: "peer_left",
            urgent: false,
            about: "dev-cd34",
            body: "IGNORED",
            subject: {
              slug: "dev-cd34",
              displayName: "Dev · cd34",
              relation: "peer",
              left: { reason: "terminated", by: "tech-lead-ab12" },
            },
          }),
        ],
      },
    ],
    /from template/,
  );
  const spawned = screen.getByText(
    (_, el) =>
      el?.tagName === "P" && textOf(el) === "Spawned by @tech-lead-ab12 from template tech-lead",
  );
  expect(spawned.querySelector("svg.lucide-git-fork")).not.toBeNull();
  expect(
    within(spawned).getByRole("link", { name: "Open @tech-lead-ab12's chat" }),
  ).toBeInTheDocument();
  expect(within(spawned).getByText("tech-lead")).toBeInTheDocument();
  const terminated = screen.getByText(
    (_, el) => el?.tagName === "P" && textOf(el) === "Terminated by @tech-lead-ab12",
  );
  expect(within(terminated).getByRole("link")).toHaveAttribute(
    "href",
    "/agents/tech-lead-ab12/chat",
  );
  const left = screen.getByText(
    (_, el) =>
      el?.tagName === "P" &&
      textOf(el) === "@dev-cd34 · Dev · cd34 left: terminated by @tech-lead-ab12",
  );
  expect(
    within(left).getByRole("link", { name: "Open @tech-lead-ab12's chat" }),
  ).toBeInTheDocument();
});
