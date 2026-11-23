import { type AgentSummary, type AgentUsageRow, taskListQuerySchema } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentDetails } from "@/features/session/agent-details";
import { type StopCrons, useStopCrons } from "@/features/session/stop-crons";
import { closeSheet, getSheetState } from "@/features/sheets/sheet-store";
import { json, mockApi, validQuery } from "@/test/mock-api";
import { agentSummary } from "@/test/session-fixtures";

afterEach(() => vi.unstubAllGlobals());

const NOW = new Date();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const totals = {
  costUsd: 4.12,
  turns: 3,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
};
const usageRow = (over: Partial<AgentUsageRow> = {}): AgentUsageRow => ({
  slug: "dev",
  displayName: "Dev agent",
  kind: "persistent",
  archived: false,
  terminated: false,
  own: totals,
  total: totals,
  ...over,
});

const taskRow = (n: number) => ({
  key: `T-${n}`,
  title: `Task number ${n}`,
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "or" },
  updatedAt: "2026-11-20T10:00:00.000Z",
});
const scheduleRow = (n: number) => ({
  key: `S-${n}`,
  target: { slug: "dev", displayName: "Dev agent", archived: false, terminated: false },
  cron: "0 9 * * *",
  timezone: "UTC",
  body: "x",
  nextRunAt: "2026-12-01T09:00:00.000Z",
  lastFiredAt: null,
  paused: false,
  done: false,
  createdBy: { kind: "user", handle: "or" },
  bodyAuthor: { kind: "user", handle: "or" },
  pendingFiring: false,
  state: "active",
});

type Props = {
  agent?: AgentSummary;
  usage?: AgentUsageRow | null | undefined;
  onClose?: () => void;
  slotsMax?: number;
  seed?: (qc: QueryClient) => void;
};

function Harness({ agent, onClose, slotsMax }: Omit<Props, "seed" | "usage">) {
  const a = agent ?? agentSummary();
  const stop: StopCrons = useStopCrons(a);
  return <AgentDetails agent={a} stop={stop} onClose={onClose} slotsMax={slotsMax} />;
}

function setup(props: Props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  props.seed?.(qc);
  // The Usage section reads the 7-day rows itself; undefined leaves it loading.
  if (props.usage !== undefined)
    qc.setQueryData(["usage", "agents", "rolling7"], {
      agents: props.usage ? [props.usage] : [],
    });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Harness agent={props.agent} onClose={props.onClose} slotsMax={props.slotsMax} />
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      stub("/tasks"),
      stub("/tasks/$key"),
      stub("/schedules"),
      stub("/schedules/$key"),
      stub("/templates/$name"),
      stub("/agents/"),
      stub("/agents/$slug"),
      stub("/agents/$slug/usage"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

const section = async (name: string) => {
  const h = await screen.findByRole("heading", { name });
  return h.parentElement as HTMLElement;
};

test("a 48px strip titled Agent details, with the agent's @slug and description", async () => {
  setup({ agent: agentSummary({ slug: "lead", description: "Keeps the roadmap moving." }) });
  expect(await screen.findByRole("heading", { name: "Agent details" })).toBeInTheDocument();
  expect(screen.getByText("@lead")).toBeInTheDocument();
  expect(screen.getByText("Keeps the roadmap moving.")).toBeInTheDocument();
});

test("Close shows only when onClose is given, and calls it", async () => {
  const onClose = vi.fn();
  const first = setup({ onClose });
  await userEvent.click(await screen.findByRole("button", { name: "Close agent details" }));
  expect(onClose).toHaveBeenCalledOnce();
  first.unmount();
  setup();
  await screen.findByRole("heading", { name: "Agent details" });
  expect(screen.queryByRole("button", { name: "Close agent details" })).toBeNull();
});

test("a long description is clamped and More reveals it all", async () => {
  const long = "word ".repeat(80).trim();
  setup({ agent: agentSummary({ description: long }) });
  const more = await screen.findByRole("button", { name: "More" });
  expect(more).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(more);
  expect(screen.getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
});

test("no Now section when nothing applies", async () => {
  setup();
  await screen.findByRole("heading", { name: "Agent details" });
  expect(screen.queryByRole("heading", { name: "Now" })).toBeNull();
});

test("Now lists every waiting task with its start, and the crons with Stop crons", async () => {
  setup({
    agent: agentSummary({
      waitingOn: {
        tasks: ["pnpm test", "pnpm build", "vite"].map((d, i) => ({
          taskId: `t${i}`,
          description: d,
          startedAt: minutesAgo(3),
        })),
        crons: 2,
      },
      crons: [
        { cronId: "c1", humanSchedule: "every 5 minutes", recurring: true, durable: false },
        { cronId: "c2", humanSchedule: "hourly", recurring: true, durable: false },
      ],
    }),
  });
  const now = within(await section("Now"));
  for (const d of ["pnpm test", "pnpm build", "vite"])
    expect(now.getByText(new RegExp(d))).toBeInTheDocument();
  expect(now.getAllByText(/since/)).toHaveLength(3);
  await userEvent.click(now.getByRole("button", { name: /2 crons/ }));
  expect(await screen.findByRole("button", { name: "Stop 2 crons" })).toBeInTheDocument();
});

test("Now: a pending restart names what it applies, with the full list below", async () => {
  const restartChanges = [
    "model: sonnet → opus",
    "added skill release",
    "added plugin x@y",
    "env LOG_LEVEL changed",
    "MCP server github added",
  ];
  setup({ agent: agentSummary({ restartPending: true, restartChanges }) });
  const now = within(await section("Now"));
  expect(now.getByText(/Restarts when idle to apply:/, { exact: false }).textContent).toContain(
    "model, 1 skill, 1 plugin and 2 more",
  );
  for (const c of restartChanges) expect(now.getByText(c)).toBeInTheDocument();
});

test("Now: restart pending explains itself with Why", async () => {
  const plural = setup({ agent: agentSummary({ restartPending: true, restartWaitingOn: 2 }) });
  expect(within(await section("Now")).getByText(/Restarts when idle/).textContent).toContain(
    "Restarts when idle to apply changes (waiting on 2 background tasks)",
  );
  plural.unmount();
  setup({ agent: agentSummary({ restartPending: true, restartWaitingOn: 1 }) });
  const now = within(await section("Now"));
  expect(now.getByText(/Restarts when idle/).textContent).toContain(
    "(waiting on 1 background task)",
  );
  await userEvent.click(now.getByRole("button", { name: "Why does it restart?" }));
  expect(await screen.findByText(/finishes its current turn/)).toBeInTheDocument();
});

test("Now: an agent pulling its image says so", async () => {
  setup({ agent: agentSummary({ pulling: true }) });
  expect(within(await section("Now")).getByText("Pulling the image…")).toBeInTheDocument();
});

test("Now: the queued detail waits for the cap, and reads in the singular for one slot", async () => {
  const unknown = setup({ agent: agentSummary({ status: "queued" }) });
  await screen.findByRole("heading", { name: "Agent details" });
  expect(screen.queryByText(/Queued:/)).toBeNull();
  unknown.unmount();
  const many = setup({ agent: agentSummary({ status: "queued" }), slotsMax: 8 });
  expect(
    within(await section("Now")).getByText("Queued: all 8 slots are in use."),
  ).toBeInTheDocument();
  many.unmount();
  setup({ agent: agentSummary({ status: "queued" }), slotsMax: 1 });
  expect(
    within(await section("Now")).getByText("Queued: the only slot is in use."),
  ).toBeInTheDocument();
});

test("Now: the rate-limited detail names the credential in mono and its reset time", async () => {
  const until = new Date(NOW.getTime() + 3_600_000);
  setup({
    agent: agentSummary({
      status: "rate_limited",
      credential: "work",
      rateLimitedUntil: until.toISOString(),
      rateLimitExact: false,
    }),
  });
  const paused = within(await section("Now")).getByText(/^Paused:/);
  expect(paused.textContent).toMatch(
    /^Paused: credential work is rate-limited, retrying at .+\. Messages wait until then\.$/,
  );
  expect(within(paused).getByText("work")).toHaveClass("font-mono");
});

test("Now: an errored agent shows its last error in full", async () => {
  setup({ agent: agentSummary({ status: "errored", lastError: "It broke\nat line 2" }) });
  const now = within(await section("Now"));
  expect(now.getByText(/It broke/).textContent).toBe("It broke\nat line 2");
});

test("Now: a terminated agent shows no queued, paused or restart row (an end state)", async () => {
  mockApi({});
  setup({
    agent: agentSummary({
      status: "terminated",
      kind: "ephemeral",
      terminatedAt: minutesAgo(10),
      restartPending: true,
      rateLimitedUntil: minutesAgo(-30),
      pulling: true,
    }),
    slotsMax: 8,
  });
  const now = await section("Now");
  expect(now.textContent).not.toMatch(/Queued|Paused|Restarts when idle|Pulling/);
});

test("Now: a terminated agent shows when it ended and offers Pin", async () => {
  mockApi({});
  setup({
    agent: agentSummary({
      status: "terminated",
      kind: "ephemeral",
      terminatedAt: minutesAgo(10),
      terminatedBy: "lead",
      workspaceGraceEndsAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    }),
  });
  const now = within(await section("Now"));
  expect(now.getByText(/Terminated/)).toBeInTheDocument();
  expect(now.getByRole("button", { name: "Pin workspace" })).toBeInTheDocument();
});

test("Now: the terminated row's actions each start a line, pulled back to the sentence's edge", async () => {
  // jsdom has no layout: this checks the structure; the browser pass checks the alignment.
  mockApi({});
  setup({
    agent: agentSummary({
      status: "terminated",
      kind: "ephemeral",
      terminatedAt: minutesAgo(10),
      workspaceGraceEndsAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    }),
  });
  const now = within(await section("Now"));
  const sentence = now.getByText(/^Terminated/);
  // The sentence fills its line, so no action sits beside it.
  expect(sentence).toHaveClass("basis-full");
  for (const name of ["Pin workspace", "What's kept?"]) {
    const button = now.getByRole("button", { name });
    // Every action is a direct item of the row the ghost-padding pull-back applies to.
    expect(button.parentElement).toBe(sentence.parentElement);
  }
  expect(sentence.parentElement?.className).toMatch(/\[&>button\]:-ml-2/);
});

test("Org: the manager, up to 8 reports, and All N reports to the Agents page", async () => {
  const reports = Array.from({ length: 10 }, (_, i) =>
    agentSummary({ slug: `r${i}`, displayName: `Report ${i}`, reportsTo: "lead" }),
  );
  const lead = agentSummary({ slug: "lead", displayName: "Lead", reportsTo: "boss", reports: 10 });
  setup({
    agent: lead,
    seed: (qc) =>
      qc.setQueryData(
        ["agents", "exclude"],
        [lead, agentSummary({ slug: "boss", displayName: "Big Boss" }), ...reports],
      ),
  });
  const org = within(await section("Org"));
  expect(org.getByText("Reports to")).toBeInTheDocument();
  expect(org.getByRole("link", { name: /Big Boss/ })).toHaveAttribute("href", "/agents/boss/chat");
  expect(org.getAllByRole("link", { name: /^Report \d$/ })).toHaveLength(8);
  expect(org.getByRole("link", { name: "All 10 reports" })).toHaveAttribute(
    "href",
    "/agents?focus=lead",
  );
});

test("Org: no link to all reports when they all fit", async () => {
  const r = agentSummary({ slug: "r", displayName: "Report", reportsTo: "lead" });
  const lead = agentSummary({ slug: "lead", reports: 1 });
  setup({ agent: lead, seed: (qc) => qc.setQueryData(["agents", "exclude"], [lead, r]) });
  const org = within(await section("Org"));
  expect(org.getByRole("link", { name: /Report/ })).toBeInTheDocument();
  expect(org.queryByRole("link", { name: /All \d+ reports/ })).toBeNull();
});

test("Work: at most 5 tasks and 5 schedules, with the counts that link to the full lists", async () => {
  const api = mockApi({
    // The server's own query schema: a parameter it refuses is a 400 here too.
    "GET /api/tasks?": validQuery(taskListQuerySchema, () =>
      json({ tasks: [1, 2, 3, 4, 5].map(taskRow), nextCursor: null }),
    ),
    "GET /api/schedules?": () => json({ schedules: [1, 2, 3, 4, 5].map(scheduleRow), more: false }),
  });
  setup({ agent: agentSummary({ openTasks: 9, scheduleCount: 7 }) });
  const work = within(await section("Work"));
  expect(await work.findByText("Task number 5")).toBeInTheDocument();
  expect(work.getAllByRole("link", { name: /^T-\d/ })).toHaveLength(5);
  expect(await work.findAllByRole("button", { name: /^S-\d/ })).toHaveLength(5);
  expect(work.getByRole("link", { name: "All 9 tasks" })).toHaveAttribute(
    "href",
    "/tasks?assignee=dev",
  );
  expect(work.getByRole("link", { name: "All 7 schedules" })).toHaveAttribute(
    "href",
    "/schedules?target=dev",
  );
  await userEvent.click(work.getByRole("button", { name: "S-2" }));
  expect(getSheetState().parent).toMatchObject({ kind: "edit-schedule", key: "S-2" });
  const taskCall = api.calls.find((c) => c.url.startsWith("/api/tasks"));
  const q = new URL(taskCall?.url ?? "", "http://x").searchParams;
  expect(q.get("assignee")).toBe("dev");
  expect(q.get("limit")).toBe("5");
  // Open and in progress is the server's default: no status parameter.
  expect(q.has("status")).toBe(false);
});

test("Work: on phones a schedule key closes the Agent details drawer at once before the sheet opens", async () => {
  mockApi({
    "GET /api/schedules?": () => json({ schedules: [1, 2].map(scheduleRow), more: false }),
  });
  act(() => closeSheet());
  let parentAtClose: unknown = "not called";
  const onClose = vi.fn(() => {
    parentAtClose = getSheetState().parent;
  });
  const { container } = setup({ agent: agentSummary({ scheduleCount: 2 }), onClose });
  const work = within(await section("Work"));
  // The phone drawer: Agent details' content carries this id and the drawer slot.
  const drawer = container.firstElementChild as HTMLElement;
  drawer.id = "agent-details";
  drawer.setAttribute("data-slot", "drawer-content");
  await userEvent.click(await work.findByRole("button", { name: "S-2" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(parentAtClose).toBeUndefined();
  expect(drawer).toHaveAttribute("data-instant");
  expect(getSheetState().parent).toMatchObject({ kind: "edit-schedule", key: "S-2" });
  act(() => closeSheet());
});

test("Work: wider than phones, a schedule key leaves Agent details open", async () => {
  mockApi({
    "GET /api/schedules?": () => json({ schedules: [1].map(scheduleRow), more: false }),
  });
  const onClose = vi.fn();
  setup({ agent: agentSummary({ scheduleCount: 1 }), onClose });
  const work = within(await section("Work"));
  await userEvent.click(await work.findByRole("button", { name: "S-1" }));
  expect(onClose).not.toHaveBeenCalled();
  expect(getSheetState().parent).toMatchObject({ kind: "edit-schedule", key: "S-1" });
  act(() => closeSheet());
});

test("Work: nothing is fetched, and no section shows, for an agent with no tasks or schedules", async () => {
  const api = mockApi({});
  setup({ agent: agentSummary({ openTasks: 0, scheduleCount: 0 }) });
  await screen.findByRole("heading", { name: "Agent details" });
  expect(screen.queryByRole("heading", { name: "Work" })).toBeNull();
  expect(
    api.calls.filter((c) => c.url.startsWith("/api/tasks") || c.url.startsWith("/api/schedules")),
  ).toEqual([]);
});

test("Usage: the 7-day estimate with a link to the usage page", async () => {
  setup({ usage: usageRow() });
  const usage = within(await section("Usage"));
  expect(usage.getByText(/\$4\.12 est\./)).toBeInTheDocument();
  expect(usage.getByRole("link", { name: /Usage/ })).toHaveAttribute("href", "/agents/dev/usage");
});

test("Usage: still links while loading or with no turns, and shows no estimate", async () => {
  const loading = setup({ usage: undefined });
  const whileLoading = within(await section("Usage"));
  expect(whileLoading.getByRole("link", { name: /Usage/ })).toHaveAttribute(
    "href",
    "/agents/dev/usage",
  );
  expect(whileLoading.queryByText(/est\./)).toBeNull();
  loading.unmount();
  const idleTotals = { ...totals, costUsd: 0, turns: 0 };
  setup({ usage: usageRow({ own: idleTotals, total: idleTotals }) });
  const noTurns = within(await section("Usage"));
  expect(noTurns.getByText("No turns in the last 7 days")).toBeInTheDocument();
  expect(noTurns.queryByText(/est\./)).toBeNull();
  expect(noTurns.getByRole("link", { name: /Usage/ })).toHaveAttribute("href", "/agents/dev/usage");
});

test("Runtime: template, credential and projects; Unsandboxed only for a local agent", async () => {
  const first = setup({
    agent: agentSummary({
      runtime: "local",
      template: "dev",
      credential: "work",
      projects: ["web"],
    }),
  });
  const rt = within(await section("Runtime"));
  expect(rt.getByRole("link", { name: "dev" })).toHaveAttribute("href", "/templates/dev");
  expect(rt.getByText("work")).toBeInTheDocument();
  expect(rt.getByText("web")).toBeInTheDocument();
  expect(rt.getByText("Unsandboxed")).toBeInTheDocument();
  first.unmount();
  setup({ agent: agentSummary({ runtime: "docker", image: "node:22" }) });
  const docker = within(await section("Runtime"));
  expect(docker.getByText("node:22")).toBeInTheDocument();
  expect(docker.queryByText("Unsandboxed")).toBeNull();
});

test("Runtime: a Configuration row opens the agent's Configuration page", async () => {
  setup({ agent: agentSummary({ slug: "ana" }) });
  const rt = within(await section("Runtime"));
  expect(rt.getByText("Configuration")).toBeInTheDocument();
  expect(rt.getByRole("link", { name: "Open configuration" })).toHaveAttribute(
    "href",
    "/agents/ana/config",
  );
});

test("Runtime: a terminated agent has no Configuration row", async () => {
  setup({
    agent: agentSummary({ status: "terminated", terminatedAt: "2026-11-19T10:00:00.000Z" }),
  });
  const rt = within(await section("Runtime"));
  expect(rt.queryByText("Configuration")).toBeNull();
  expect(rt.queryByRole("link", { name: "Open configuration" })).toBeNull();
});

test("Runtime: a deleted credential leaves no empty row; a disabled local runtime says so", async () => {
  setup({
    agent: agentSummary({ runtime: "local", credential: null, runtimeDisabled: "disabled" }),
  });
  const rt = await section("Runtime");
  expect(rt.textContent).not.toContain("Credential");
  expect(rt.textContent).toContain("Unsandboxed · disabled on this factory");
});

test("Runtime: a disabled local runtime explains itself in a Why popover (distinct label, one paragraph)", async () => {
  setup({
    agent: agentSummary({ runtime: "local", runtimeDisabled: "disabled", restartPending: true }),
  });
  const rt = within(await section("Runtime"));
  await userEvent.click(rt.getByRole("button", { name: "Why is the local runtime disabled?" }));
  const pop = await screen.findByText(/An operator has to allow unsandboxed agents/);
  expect(pop.textContent).toBe(
    "An operator has to allow unsandboxed agents by setting FACTORY_ALLOW_LOCAL_RUNTIME=true. Until then this agent can't start.",
  );
  expect(within(pop).getByText("FACTORY_ALLOW_LOCAL_RUNTIME=true")).toHaveClass("font-mono");
  expect(pop.tagName).toBe("P");
  expect(pop.parentElement?.children).toHaveLength(1);
  // The restart Why has its own name.
  expect(screen.getByRole("button", { name: "Why does it restart?" })).toBeInTheDocument();
});

test("Org: a spawned agent says 'Spawned by'; a root has No manager", async () => {
  const first = setup({ agent: agentSummary({ kind: "ephemeral", reportsTo: "lead" }) });
  expect(within(await section("Org")).getByText("Spawned by")).toBeInTheDocument();
  first.unmount();
  setup({ agent: agentSummary({ reportsTo: null }) });
  expect(within(await section("Org")).getByText("No manager")).toBeInTheDocument();
});

test("Edit agent is an outline button for a persistent, unarchived agent only, and opens the sheet", async () => {
  const first = setup();
  const edit = await screen.findByRole("button", { name: "Edit agent" });
  expect(edit).toHaveAttribute("data-variant", "outline");
  await userEvent.click(edit);
  expect(getSheetState().parent).toMatchObject({ kind: "edit-agent", slug: "dev" });
  first.unmount();
  const second = setup({ agent: agentSummary({ kind: "ephemeral" }) });
  await screen.findByRole("heading", { name: "Agent details" });
  expect(screen.queryByRole("button", { name: "Edit agent" })).toBeNull();
  second.unmount();
  setup({ agent: agentSummary({ archivedAt: "2026-11-01T00:00:00.000Z" }) });
  await screen.findByRole("heading", { name: "Agent details" });
  expect(screen.queryByRole("button", { name: "Edit agent" })).toBeNull();
});
