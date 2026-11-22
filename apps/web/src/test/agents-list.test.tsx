import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { mockWorld } from "@/test/agent-screens-fixtures";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
let pushFrame: (m: unknown) => void = () => {};
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: unknown) => void }) => {
    pushFrame = (m) => o.onMessage?.(m);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
afterEach(() => vi.unstubAllGlobals());

const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("lists agents with status label, slug and the unsandboxed badge", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [agentSummary({ status: "working", turnOpen: true, template: "developer" })],
        running: { count: 0, max: 8 },
      }),
    ),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(row).toHaveAttribute("href", "/agents/dev");
  expect(within(row).getByText("Working")).toBeInTheDocument();
  expect(within(row).getAllByText("@dev").length).toBeGreaterThan(0);
  expect(within(row).getByText("developer")).toBeInTheDocument();
  expect(within(row).getByText("Unsandboxed")).toBeInTheDocument();
});

test("an empty list points at creating an agent from a template", async () => {
  mockWorld({ agents: [] });
  renderApp("/agents", alice);
  // The sidebar tree says it too: the page is the main region.
  const main = await screen.findByRole("main");
  expect(await within(main).findByText(/No agents yet\./)).toHaveTextContent(
    "No agents yet. Create one from a template.",
  );
  expect(screen.queryByText(/seed:dev-agent/)).not.toBeInTheDocument();
});

test("a pushed agent_status frame turns the row's Working into Idle", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [agentSummary({ status: "working", turnOpen: true })],
        running: { count: 0, max: 8 },
      }),
    ),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(within(row).getByText("Working")).toBeInTheDocument();
  act(() =>
    pushFrame({
      type: "agent_status",
      agent: "dev",
      status: "idle",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
    }),
  );
  expect(await within(row).findByText("Idle")).toBeInTheDocument();
  expect(within(row).queryByText("Working")).not.toBeInTheDocument();
});

test("a failed list says so", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
  renderApp("/agents", alice);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load agents.");
});

const listWith = (agents: ReturnType<typeof agentSummary>[], running = { count: 3, max: 8 }) =>
  mockWorld({
    agents,
    extra: { "GET /api/agents?ended=exclude": () => json({ agents, running }) },
  });

test("Agents list: inline note priority, '3 of 8 running' before the radio pair, hidden on Ended", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 19, 10, 0));
  const until = new Date(2026, 10, 19, 14, 30).toISOString();
  const tasks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      taskId: `t${i}`,
      description: "x",
      startedAt: until,
    }));
  listWith([
    agentSummary({
      slug: "a",
      displayName: "Disabled",
      runtimeDisabled: "The local runtime is disabled on this factory.",
      status: "rate_limited",
      rateLimitedUntil: until,
      waitingOn: { tasks: tasks(2), crons: 2 },
    }),
    agentSummary({
      slug: "b",
      displayName: "Paused",
      status: "rate_limited",
      rateLimitedUntil: until,
      rateLimitExact: false,
      waitingOn: { tasks: tasks(2), crons: 2 },
    }),
    agentSummary({
      slug: "c",
      displayName: "Exact",
      status: "rate_limited",
      rateLimitedUntil: until,
      rateLimitExact: true,
    }),
    agentSummary({ slug: "d", displayName: "Busy", waitingOn: { tasks: tasks(2), crons: 2 } }),
    agentSummary({ slug: "e", displayName: "One", waitingOn: { tasks: tasks(1), crons: 0 } }),
    agentSummary({ slug: "f", displayName: "Pinned", waitingOn: { tasks: [], crons: 1 } }),
    agentSummary({ slug: "g", displayName: "Plain" }),
  ]);
  const { router } = renderApp("/agents", alice);
  const note = async (name: string) => {
    const row = await screen.findByRole("link", { name: new RegExp(name) });
    return row.querySelector("[data-agent-note]")?.textContent ?? null;
  };
  expect(await note("Disabled")).toBe("Local runtime disabled");
  expect(await note("Paused")).toBe("retrying at 14:30");
  expect(await note("Exact")).toBe("until 14:30");
  expect(await note("Busy")).toBe("Waiting on 2 tasks");
  expect(await note("One")).toBe("Waiting on 1 task");
  expect(await note("Pinned")).toBe("1 cron");
  expect(await note("Plain")).toBeNull();
  // Plain text only: nothing interactive inside the row link.
  const busy = screen.getByRole("link", { name: /Busy/ });
  expect(busy.querySelector("[data-agent-note]")).toHaveClass("text-muted-foreground");
  expect(within(busy).queryByRole("button")).toBeNull();

  const count = screen.getByText("3 of 8 running");
  expect(count).toHaveClass("max-md:hidden");
  const radios = screen.getByRole("group", { name: "Show" });
  expect(count.compareDocumentPosition(radios) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() => pushFrame({ type: "supervisor", running: 4, max: 8 }));
  expect(await screen.findByText("4 of 8 running")).toBeInTheDocument();

  await act(() => router.navigate({ to: "/agents", search: { ended: "only" } }));
  await screen.findByText("No ended agents.");
  expect(screen.queryByText(/of 8 running/)).not.toBeInTheDocument();
  vi.useRealTimers();
});

test("a terminated frame shows Terminated (no dot) at once, then the list refetches without it", async () => {
  // The refetch waits until released, so the patched row can be seen first.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // The sidebar's unread count is not what this test counts.
      if (!url.startsWith("/api/agents")) return json({ count: 0 });
      if (calls++ > 0) await held;
      return json({
        agents: calls > 1 ? [] : [agentSummary({ slug: "x-ab12", displayName: "X · ab12" })],
        running: { count: 0, max: 8 },
      });
    }),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /X · ab12/ });
  act(() =>
    pushFrame({
      type: "agent_status",
      agent: "x-ab12",
      status: "terminated",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
    }),
  );
  expect(await within(row).findByText("Terminated")).toBeInTheDocument();
  expect(row.querySelector("[data-status-dot]")).toBeNull();
  release();
  // It moves to the Ended view: the list is refetched rather than kept with an end state in it.
  await vi.waitFor(() =>
    expect(screen.queryByRole("link", { name: /X · ab12/ })).not.toBeInTheDocument(),
  );
});

test("an empty list holds its line with a skeleton while the prerequisites load", async () => {
  // The credentials list never answers, so the prerequisites stay loading.
  const api = mockWorld({
    agents: [],
    extra: { "GET /api/credentials": () => new Promise<Response>(() => {}) },
  });
  renderApp("/agents", alice);
  await vi.waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/agents?ended=exclude")).toBe(true),
  );
  const plate = await vi.waitFor(() => {
    const el = document.querySelector("[data-empty-agents] [data-slot=skeleton]");
    expect(el).not.toBeNull();
    return el;
  });
  expect(plate).toHaveClass("h-5");
  expect(within(screen.getByRole("main")).queryByText(/No agents yet\./)).not.toBeInTheDocument();
});

test("?focus scrolls that agent's row into view and marks it for the visit", async () => {
  const scrolled: Element[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolled.push(this);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [
          agentSummary({ slug: "lead", displayName: "Lead agent" }),
          agentSummary({ slug: "other", displayName: "Other agent" }),
        ],
        running: { count: 0, max: 8 },
      }),
    ),
  );
  renderApp("/agents?focus=lead", alice);
  const main = await screen.findByRole("main");
  const lead = await within(main).findByRole("link", { name: /Lead agent/ });
  await waitFor(() => expect(scrolled.some((el) => lead.contains(el) || el === lead)).toBe(true));
  expect(lead).toHaveAttribute("data-focused");
  expect(within(main).getByRole("link", { name: /Other agent/ })).not.toHaveAttribute(
    "data-focused",
  );
});
