import type { AgentUsageRow, CredentialUsageRow, Totals } from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { type Handler, json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

const totals = (o: Partial<Totals> = {}): Totals => ({
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  turns: 0,
  ...o,
});
function daily(n: number, cost = 0.5, turns = 1) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 20 - (n - 1 - i)));
    return { date: d.toISOString().slice(0, 10), ...totals({ costUsd: cost, turns }) };
  });
}
const usageRow = (o: Partial<AgentUsageRow> & { slug: string }): AgentUsageRow => ({
  displayName: o.slug,
  kind: "persistent",
  archived: false,
  terminated: false,
  own: totals(),
  total: o.own ?? totals(),
  ...o,
});
const credUsage = (o: Partial<CredentialUsageRow> = {}): CredentialUsageRow => ({
  name: "work",
  kind: "oauth_token",
  totals: totals(),
  agents: [],
  rateLimit: null,
  ...o,
});
type World = {
  daily?: ReturnType<typeof daily>;
  agents?: AgentUsageRow[];
  credentials?: CredentialUsageRow[];
  extra?: Record<string, Handler>;
};

function world(w: World = {}) {
  const api = mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/agents": () => json({ agents: [], running: { count: 0 } }),
    "GET /api/usage/daily?": () =>
      json({ timezone: "Europe/Berlin", days: w.daily ?? daily(30, 0, 0) }),
    "GET /api/usage/agents?": () => json({ agents: w.agents ?? [] }),
    "GET /api/usage/credentials?": () =>
      json({ credentials: w.credentials ?? [], unattributed: totals() }),
    ...w.extra,
  });
  return { api };
}
const page = () => screen.findByRole("heading", { level: 1, name: "Usage" });

const leadFamily = (): AgentUsageRow[] => [
  usageRow({
    slug: "writer",
    own: totals({ costUsd: 0.5, turns: 4 }),
    total: totals({ costUsd: 0.5, turns: 4 }),
  }),
  usageRow({
    slug: "lead",
    own: totals({ costUsd: 1.2, turns: 12 }),
    spawned: totals({ costUsd: 3.4, turns: 29 }),
    total: totals({ costUsd: 4.6, turns: 41 }),
  }),
  ...["lead-a1", "lead-b2", "lead-c3"].map((slug, i) =>
    usageRow({
      slug,
      kind: "ephemeral",
      spawnerSlug: "lead",
      terminated: i === 0,
      own: totals({ costUsd: 1 + i * 0.2, turns: 9 + i }),
      total: totals({ costUsd: 1 + i * 0.2, turns: 9 + i }),
    }),
  ),
  ...Array.from({ length: 8 }, (_, i) => usageRow({ slug: `idle-${i}` })),
];

test("Usage: range, Daily chart, estimate line, and the Agents table sorted by total", async () => {
  const api = world({ daily: daily(30), agents: leadFamily() }).api;
  renderApp("/usage", alice);
  await page();
  expect(screen.getByRole("radio", { name: "30 days" })).toBeChecked();
  // The Usage page, not a Settings page.
  expect(screen.queryByRole("navigation", { name: "Settings" })).not.toBeInTheDocument();
  expect(await screen.findByRole("heading", { level: 3, name: "Daily" })).toBeInTheDocument();
  expect(screen.getByText("30 days to today, in Europe/Berlin.")).toBeInTheDocument();
  expect(
    screen.getByText("Estimated at API prices. A subscription is billed by plan, not per token."),
  ).toBeInTheDocument();
  expect(api.calls.some((c) => c.url === "/api/usage/agents?days=30")).toBe(true);

  const table = screen.getByRole("table", { name: "Agents" });
  const headers = within(table)
    .getAllByRole("columnheader")
    .map((h) => h.textContent);
  expect(headers).toEqual(["Agent", "Turns", "Own (est.)", "Spawned (est.)", "Total (est.)"]);
  const bodyRows = within(table).getAllByRole("row").slice(1);
  // lead (4.60) before writer (0.50); the children are collapsed behind the disclosure.
  expect(bodyRows[0]).toHaveTextContent("@lead");
  expect(bodyRows[0]).toHaveTextContent("$1.20");
  expect(bodyRows[0]).toHaveTextContent("$3.40");
  expect(bodyRows[0]).toHaveTextContent("$4.60");
  const lead = within(table).getByRole("link", { name: "@lead" });
  expect(lead).toHaveAttribute("href", "/agents/lead/usage");
  expect(within(table).queryByText("@lead-a1")).not.toBeInTheDocument();

  const disclosure = within(table).getByRole("button", { name: "Show 3 spawned agents of @lead" });
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const child = within(table).getByRole("link", { name: "@lead-c3" });
  expect(child).toHaveAttribute("href", "/agents/lead-c3/usage");
  const childRow = child.closest("tr") as HTMLElement;
  const cells = within(childRow).getAllByRole("cell");
  // Agent, turns, own, spawned (blank), total.
  expect(cells[2]).toHaveTextContent("$1.40");
  expect(cells[3]).toHaveTextContent(/^$/);
  expect(cells[4]).toHaveTextContent("$1.40");
  expect(within(table).getByText("@writer").closest("tr")).toHaveTextContent("$0.50");
});

test("Usage: agents with no usage fold into one row with Show", async () => {
  world({ daily: daily(30), agents: leadFamily() });
  renderApp("/usage", alice);
  await page();
  const table = await screen.findByRole("table", { name: "Agents" });
  expect(within(table).queryByText("@idle-0")).not.toBeInTheDocument();
  const fold = within(table).getByText("8 agents with no usage").closest("tr") as HTMLElement;
  const show = within(fold).getByRole("button", { name: "Show" });
  expect(show).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(show);
  expect(within(table).getByRole("link", { name: "@idle-7" })).toHaveAttribute(
    "href",
    "/agents/idle-7/usage",
  );
});

test("Usage: the By credential table with cost, top agents and the rate-limit line", async () => {
  world({
    daily: daily(30),
    agents: leadFamily(),
    credentials: [
      credUsage({
        totals: totals({ costUsd: 4.12, turns: 30 }),
        agents: [
          { slug: "lead", costUsd: 3 },
          { slug: "writer", costUsd: 1.12 },
        ],
        rateLimit: {
          status: "allowed_warning",
          type: "five_hour",
          utilization: 0.82,
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          observedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      }),
    ],
  });
  renderApp("/usage", alice);
  await page();
  const table = await screen.findByRole("table", { name: "By credential" });
  // The scroll region has its own name, apart from the table's heading.
  expect(screen.getByRole("region", { name: "Credential usage" })).toContainElement(table);
  const headers = within(table).getAllByRole("columnheader");
  expect(headers.map((h) => h.textContent)).toEqual([
    "Name",
    "Kind",
    "Cost (est.)",
    "Top agents",
    "Rate limit",
  ]);
  const r = within(table).getAllByRole("row")[1] as HTMLElement;
  const cells = within(r).getAllByRole("cell");
  expect(r).toHaveTextContent("work");
  expect(r).toHaveTextContent("OAuth token");
  expect(r).toHaveTextContent("$4.12");
  expect(within(r).getByRole("link", { name: "@lead" })).toHaveAttribute(
    "href",
    "/agents/lead/usage",
  );
  expect(cells[4]).toHaveTextContent("82% of the 5-hour limit used");
});

test("the rate-limit lines' usage credentials refetch every minute while Usage is open", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const { api } = world({ daily: daily(30), credentials: [credUsage()] });
    renderApp("/usage", alice);
    await screen.findByRole("table", { name: "By credential" });
    const count = (url: string) => api.calls.filter((c) => c.url === url).length;
    const usage = count("/api/usage/credentials?days=30");
    vi.advanceTimersByTime(60_000);
    await waitFor(() => expect(count("/api/usage/credentials?days=30")).toBe(usage + 1));
  } finally {
    vi.useRealTimers();
  }
});

test("Usage: all-zero days show the empty line instead of the chart; credentials stay", async () => {
  world({
    daily: daily(30, 0, 0),
    agents: [usageRow({ slug: "lead" })],
    credentials: [credUsage()],
  });
  renderApp("/usage", alice);
  await page();
  expect(await screen.findByText("No usage in the last 30 days.")).toBeInTheDocument();
  expect(screen.queryByText("30 days to today, in Europe/Berlin.")).not.toBeInTheDocument();
  const table = screen.getByRole("table", { name: "By credential" });
  expect(table).toHaveTextContent("work");
  expect(table).toHaveTextContent("No rate-limit data yet");
});

test("Usage: ?days=7 asks for 7 days and a range switch keeps the page", async () => {
  const { api } = world({ daily: daily(7), agents: leadFamily() });
  const { router } = renderApp("/usage?days=7", alice);
  await page();
  expect(screen.getByRole("radio", { name: "7 days" })).toBeChecked();
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/usage/daily?days=7")).toBe(true),
  );
  await userEvent.click(screen.getByRole("radio", { name: "90 days" }));
  await waitFor(() => expect(router.state.location.search).toEqual({ days: 90 }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === "/api/usage/credentials?days=90")).toBe(true),
  );
});

test("a failing usage query shows Couldn't load usage. with Retry", async () => {
  world({
    extra: {
      "GET /api/usage/agents?": () => json({ error: { code: "internal", message: "boom" } }, 500),
    },
  });
  renderApp("/usage", alice);
  await page();
  expect(await screen.findByText("Couldn't load usage.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

test("the per-credential table is headed By credential; the app has one Credentials heading", async () => {
  world({ daily: daily(30), agents: leadFamily(), credentials: [credUsage()] });
  const { router } = renderApp("/usage", alice);
  await screen.findByRole("table", { name: "By credential" });
  expect(screen.getByRole("heading", { name: "By credential" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Credentials" })).not.toBeInTheDocument();
  await router.navigate({ to: "/settings/credentials" });
  expect(await screen.findAllByRole("heading", { name: "Credentials" })).toHaveLength(1);
});
