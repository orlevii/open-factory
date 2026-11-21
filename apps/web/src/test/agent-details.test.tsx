import type { AgentSummary, AgentUsageRow } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentDetails } from "@/features/session/agent-details";
import { type StopCrons, useStopCrons } from "@/features/session/stop-crons";
import { json, mockApi } from "@/test/mock-api";
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
  seed?: (qc: QueryClient) => void;
};

function Harness({ agent, usage, onClose }: Omit<Props, "seed">) {
  const a = agent ?? agentSummary();
  const stop: StopCrons = useStopCrons(a);
  return <AgentDetails agent={a} stop={stop} usage={usage} onClose={onClose} />;
}

function setup(props: Props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  props.seed?.(qc);
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Harness agent={props.agent} usage={props.usage} onClose={props.onClose} />
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
      stub("/agents/$slug/edit"),
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

test("Now: restart pending explains itself with Why", async () => {
  setup({ agent: agentSummary({ restartPending: true, restartWaitingOn: 1 }) });
  const now = within(await section("Now"));
  expect(now.getByText(/Restarts when idle/)).toBeInTheDocument();
  await userEvent.click(now.getByRole("button", { name: "Why does it restart?" }));
  expect(await screen.findByText(/finishes its current turn/)).toBeInTheDocument();
});

test("Now: the queued and rate-limited details", async () => {
  const first = setup({ agent: agentSummary({ status: "rate_limited", credential: "work" }) });
  expect(within(await section("Now")).getByText(/credential/)).toBeInTheDocument();
  first.unmount();
  setup({ agent: agentSummary({ pulling: true }) });
  expect(within(await section("Now")).getByText("Pulling the image…")).toBeInTheDocument();
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
  expect(org.getByRole("link", { name: /Big Boss/ })).toHaveAttribute("href", "/agents/boss");
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
    "GET /api/tasks?": () => json({ tasks: [1, 2, 3, 4, 5].map(taskRow), nextCursor: null }),
    "GET /api/schedules?": () => json({ schedules: [1, 2, 3, 4, 5].map(scheduleRow), more: false }),
  });
  setup({ agent: agentSummary({ openTasks: 9, scheduleCount: 7 }) });
  const work = within(await section("Work"));
  expect(await work.findByText("Task number 5")).toBeInTheDocument();
  expect(work.getAllByRole("link", { name: /^T-\d/ })).toHaveLength(5);
  expect(await work.findAllByRole("link", { name: /^S-\d/ })).toHaveLength(5);
  expect(work.getByRole("link", { name: "All 9 tasks" })).toHaveAttribute(
    "href",
    "/tasks?assignee=dev",
  );
  expect(work.getByRole("link", { name: "All 7 schedules" })).toHaveAttribute(
    "href",
    "/schedules?target=dev",
  );
  const taskCall = api.calls.find((c) => c.url.startsWith("/api/tasks"));
  expect(taskCall?.url).toContain("assignee=dev");
  expect(taskCall?.url).toContain("limit=5");
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

test("Usage: still links while loading or with no turns", async () => {
  setup({ usage: undefined });
  const usage = within(await section("Usage"));
  expect(usage.getByRole("link", { name: /Usage/ })).toHaveAttribute("href", "/agents/dev/usage");
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

test("Edit agent is an outline button for a persistent, unarchived agent only", async () => {
  const first = setup();
  const edit = await screen.findByRole("link", { name: "Edit agent" });
  expect(edit).toHaveAttribute("href", "/agents/dev/edit");
  expect(edit).toHaveAttribute("data-variant", "outline");
  first.unmount();
  const second = setup({ agent: agentSummary({ kind: "ephemeral" }) });
  await screen.findByRole("heading", { name: "Agent details" });
  expect(screen.queryByRole("link", { name: "Edit agent" })).toBeNull();
  second.unmount();
  setup({ agent: agentSummary({ archivedAt: "2026-11-01T00:00:00.000Z" }) });
  await screen.findByRole("heading", { name: "Agent details" });
  expect(screen.queryByRole("link", { name: "Edit agent" })).toBeNull();
});
