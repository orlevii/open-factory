import type { AgentSummary, ServerMessage } from "@open-factory/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { enqueueStatusFrame, flushStatusFrames } from "@/features/agents/status-frames";
import { agentsQueryOptions } from "@/features/session/api";
import { createQueryClient } from "@/lib/query-client";
import { WsContext, type WsHub } from "@/lib/ws-context";
import { json, mockApi } from "@/test/mock-api";
import { renderInRouter } from "@/test/render-in-router";
import { agentSummary } from "@/test/session-fixtures";
import { HomeAgents, orderHomeAgents } from "./home-agents";

const a = (slug: string, displayName: string, over: Partial<AgentSummary> = {}) =>
  agentSummary({ slug, displayName, ...over });

async function setup(agents: AgentSummary[] | "pending" | "error") {
  const qc = createQueryClient({ queries: { retry: false } });
  // The seeded list stays as given: the mount refetch never settles.
  mockApi({
    "GET /api/agents?": () =>
      agents === "error"
        ? json({ error: { code: "boom", message: "x" } }, 500)
        : new Promise<Response>(() => {}),
  });
  if (Array.isArray(agents)) qc.setQueryData(agentsQueryOptions.queryKey, agents);
  let listener: (m: ServerMessage) => void = () => {};
  const hub: WsHub = {
    send: () => true,
    listen: (fn) => {
      listener = fn;
      return () => {};
    },
    status: "open",
    openCount: 1,
  };
  const view = renderInRouter(
    <QueryClientProvider client={qc}>
      <WsContext.Provider value={hub}>
        <section aria-label="panel">
          <HomeAgents />
        </section>
      </WsContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole("region", { name: "panel" });
  // The shell enqueues status frames; the flush lands them (AppLayout is not mounted here).
  const push = (m: ServerMessage) =>
    act(() => {
      enqueueStatusFrame(qc, m);
      flushStatusFrames();
      listener(m);
    });
  return { qc, view, push };
}
const statusFrame = (agent: string, status: AgentSummary["status"]): ServerMessage => ({
  type: "agent_status",
  agent,
  status,
  turnOpen: false,
  restartPending: false,
  restartWaitingOn: 0,
});
/** HomeAgents' own root (the element that carries the hover and focus handlers). */
const panel = async () =>
  (await screen.findByRole("list", { name: "Agents" })).parentElement as HTMLElement;
const slugs = () =>
  screen.getAllByRole("link").map((l) => l.getAttribute("href")?.replace("/agents/", ""));

test("needs attention first, then working, then the rest; ties by name then slug", () => {
  const out = orderHomeAgents([
    a("idle-1", "Bea"),
    a("w-1", "Ann", { status: "working" }),
    a("err", "Zed", { status: "errored" }),
    a("stuck", "Cal", { status: "idle", stuck: true }),
    a("dup-b", "Bea"),
    a("spawn", "Kid", { kind: "ephemeral" }),
    a("arch", "Old", { archivedAt: "2026-01-01T00:00:00Z" }),
  ]);
  expect(out.map((x) => x.slug)).toEqual(["stuck", "err", "w-1", "dup-b", "idle-1"]);
});

test("rows link to the agent and show the visible status label; stuck and restart pending say so", async () => {
  await setup([
    a("w", "Wes", { status: "working" }),
    a("s", "Sam", { stuck: true }),
    a("r", "Rex", { restartPending: true }),
  ]);
  const w = await screen.findByRole("link", { name: /Wes/ });
  expect(w).toHaveAttribute("href", "/agents/w");
  expect(within(w).getByText("Working")).toBeInTheDocument();
  expect(within(screen.getByRole("link", { name: /Sam/ })).getByText("Stuck")).toBeInTheDocument();
  expect(
    within(screen.getByRole("link", { name: /Rex/ })).getByText("Restart pending"),
  ).toBeInTheDocument();
});

test("shows 8 rows and an All N agents link past 8", async () => {
  await setup(Array.from({ length: 14 }, (_, i) => a(`a${String(i).padStart(2, "0")}`, `N${i}`)));
  const all = await screen.findByRole("link", { name: "All 14 agents" });
  expect(all).toHaveAttribute("href", "/agents");
  expect(screen.getAllByRole("link")).toHaveLength(9);
});

test("no all-link at 8 or fewer", async () => {
  await setup([a("x", "X")]);
  await screen.findByRole("link", { name: /X/ });
  expect(screen.queryByRole("link", { name: /All/ })).toBeNull();
});

test("empty shows a line and a New agent link", async () => {
  await setup([]);
  expect(await screen.findByText("No agents yet.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "New agent" })).toHaveAttribute("href", "/agents/new");
});

test("error shows a line", async () => {
  await setup("error");
  expect(await screen.findByText("Couldn't load agents.")).toBeInTheDocument();
});

test("loading shows three skeleton plates", async () => {
  const { view } = await setup("pending");
  expect(view.container.querySelectorAll("[data-slot=skeleton]")).toHaveLength(3);
});

const fleet = () => [a("idle-1", "Bea"), a("w-1", "Ann", { status: "working" })];
const err = (qc: QueryClient) =>
  act(() =>
    qc.setQueryData(agentsQueryOptions.queryKey, [
      a("idle-1", "Bea", { status: "errored" }),
      a("w-1", "Ann", { status: "working" }),
    ]),
  );

test.each([
  [
    "pointer",
    (p: HTMLElement) => fireEvent.pointerEnter(p),
    (p: HTMLElement) => fireEvent.pointerLeave(p),
  ],
  ["focus", (p: HTMLElement) => fireEvent.focusIn(p), (p: HTMLElement) => fireEvent.focusOut(p)],
])("frozen order under %s: updates in place, reorders on release", async (_n, engage, release) => {
  const { qc } = await setup(fleet());
  const p = await panel();
  expect(slugs()).toEqual(["w-1", "idle-1"]);
  engage(p);
  err(qc);
  expect(
    await within(await screen.findByRole("link", { name: /Bea/ })).findByText("Errored"),
  ).toBeInTheDocument();
  expect(slugs()).toEqual(["w-1", "idle-1"]);
  release(p);
  await waitFor(() => expect(slugs()).toEqual(["idle-1", "w-1"]));
});

test("pointer leaving while focus stays inside keeps the order frozen", async () => {
  const { qc } = await setup(fleet());
  const p = await panel();
  fireEvent.pointerEnter(p);
  fireEvent.focusIn(p);
  fireEvent.pointerLeave(p);
  err(qc);
  expect(
    await within(await screen.findByRole("link", { name: /Bea/ })).findByText("Errored"),
  ).toBeInTheDocument();
  expect(slugs()).toEqual(["w-1", "idle-1"]);
  fireEvent.focusOut(p);
  await waitFor(() => expect(slugs()).toEqual(["idle-1", "w-1"]));
});

test("an agent appearing while frozen is appended last", async () => {
  const { qc } = await setup(fleet());
  const p = await panel();
  fireEvent.pointerEnter(p);
  act(() =>
    qc.setQueryData(agentsQueryOptions.queryKey, [
      ...fleet(),
      a("new", "Aaa", { status: "errored" }),
    ]),
  );
  await waitFor(() => expect(slugs()).toEqual(["w-1", "idle-1", "new"]));
});

test("agent_status frames update rows live (folded in by the shell)", async () => {
  const { push } = await setup(fleet());
  expect(slugs()).toEqual(["w-1", "idle-1"]);
  push(statusFrame("idle-1", "errored"));
  expect(
    await within(screen.getByRole("link", { name: /Bea/ })).findByText("Errored"),
  ).toBeInTheDocument();
  await waitFor(() => expect(slugs()).toEqual(["idle-1", "w-1"]));
});

test("a status frame under the pointer updates the row in place; the order applies on leave", async () => {
  const { push } = await setup(fleet());
  const p = await panel();
  fireEvent.pointerEnter(p);
  push(statusFrame("idle-1", "errored"));
  expect(
    await within(screen.getByRole("link", { name: /Bea/ })).findByText("Errored"),
  ).toBeInTheDocument();
  expect(slugs()).toEqual(["w-1", "idle-1"]);
  fireEvent.pointerLeave(p);
  await waitFor(() => expect(slugs()).toEqual(["idle-1", "w-1"]));
});

test("hovering before the query resolves still renders rows when it does", async () => {
  const { qc, view } = await setup("pending");
  fireEvent.pointerEnter(
    view.container.querySelector("[data-slot=skeleton]")?.parentElement
      ?.parentElement as HTMLElement,
  );
  act(() => qc.setQueryData(agentsQueryOptions.queryKey, fleet()));
  await waitFor(() => expect(slugs()).toEqual(["w-1", "idle-1"]));
});

vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

test("the slug truncates before the name, and the extra label is readable text", async () => {
  await setup([a("s", "Sam", { stuck: true })]);
  const row = await screen.findByRole("link", { name: /Sam/ });
  expect(within(row).getByText("@s")).toHaveClass("shrink-[999]");
  expect(within(row).getByText("Sam")).not.toHaveClass("shrink-[999]");
  expect(within(row).getByText("Stuck")).toHaveClass("text-muted-foreground");
  expect(within(row).getByText("Stuck")).not.toHaveClass("text-warning");
});
