import type { AgentUsage, Totals } from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { principal } from "@/test/chat-fixtures";
import { json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

const totals = (o: Partial<Totals> = {}): Totals => ({
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  turns: 0,
  ...o,
});

function daily(n: number, cost = 0.5) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 20 - (n - 1 - i)));
    return { date: d.toISOString().slice(0, 10), ...totals({ costUsd: cost, turns: 1 }) };
  });
}

const usage = (o: Partial<AgentUsage> = {}): AgentUsage => ({
  agent: { ref: refFor("lead"), handle: "lead", displayName: "Lead", kind: "persistent" },
  timezone: "Europe/Berlin",
  total: totals({
    costUsd: 4.6,
    turns: 41,
    inputTokens: 1_200_000,
    outputTokens: 340_000,
    cacheWriteTokens: 2_100_000,
    cacheReadTokens: 18_000_000,
  }),
  own: totals({ costUsd: 1.2, turns: 12 }),
  daily: daily(30),
  byModel: [
    { model: "claude-opus-4-5", ...totals({ costUsd: 4.1, turns: 30, inputTokens: 5000 }) },
    { model: null, ...totals({ costUsd: 0.5, turns: 11 }) },
  ],
  byTask: [{ key: "T-12", title: "Fix the build", ...totals({ costUsd: 1.23, turns: 14 }) }],
  spawned: [
    {
      ref: refFor("lead-ab12"),
      handle: "lead-ab12",
      displayName: "Helper",
      terminated: true,
      ...totals({ costUsd: 3.4, turns: 29 }),
    },
  ],
  ...o,
});

const URL_PREFIX = `GET /api/agents/${refFor("lead")}/usage?`;
const daysOf = (url: string) => new URL(url, "http://x").searchParams.get("days");

test("defaults to 30 days, with back link, title, totals, estimate line and tables", async () => {
  const api = mockApi({ [URL_PREFIX]: () => json(usage()) });
  renderApp(`/agents/${refFor("lead")}/usage`, alice);

  await screen.findByText("Estimated cost");
  const usageCalls = api.calls.filter((c) =>
    c.url.startsWith(`/api/agents/${refFor("lead")}/usage`),
  );
  expect(usageCalls.map((c) => daysOf(c.url))).toContain("30");
  expect(screen.getByRole("radio", { name: "30 days" })).toBeChecked();
  expect(screen.getByRole("group", { name: "Range" })).toBeInTheDocument();

  const back = screen.getByRole("link", { name: "← @lead" });
  expect(back).toHaveAttribute("href", `/agents/${refFor("lead")}/chat`);
  await waitFor(() => expect(document.title).toBe("Usage · Lead · Open Factory"));

  const dl = document.querySelector("dl") as HTMLElement;
  expect(within(dl).getByText("$4.60")).toBeInTheDocument();
  expect(within(dl).getByText("Own $1.20 · spawned $3.40")).toBeInTheDocument();
  expect(within(dl).getByText("41")).toBeInTheDocument();
  const tokensLine = within(dl).getAllByText(
    (_, el) =>
      el?.tagName === "DIV" &&
      el.textContent === "Tokens: 1.2M in · 340k out · 2.1M cache write · 18M cache read",
  );
  expect(tokensLine).toHaveLength(1);
  expect(
    screen.getByText("Estimated at API prices. A subscription is billed by plan, not per token."),
  ).toBeInTheDocument();
  expect(screen.getByText("30 days to today, in Europe/Berlin.")).toBeInTheDocument();

  const byModel = screen.getByRole("table", { name: "By model" });
  expect(within(byModel).getByText("claude-opus-4-5")).toBeInTheDocument();
  expect(within(byModel).getByText("Unknown model")).toBeInTheDocument();
  expect(within(byModel).getByText("$4.10")).toBeInTheDocument();

  const byTask = screen.getByRole("table", { name: "By task" });
  expect(screen.getByRole("heading", { name: "By task" })).toBeInTheDocument();
  expect(
    screen.getByText(
      "Counts only turns that handled this task's messages and nothing else. Real usage can be higher.",
    ),
  ).toBeInTheDocument();
  expect(within(byTask).getByRole("link", { name: "T-12" })).toHaveAttribute("href", "/tasks/T-12");
  expect(within(byTask).getByText("Fix the build")).toBeInTheDocument();

  const spawned = screen.getByRole("table", { name: "Spawned agents" });
  expect(within(spawned).getByRole("link", { name: "@lead-ab12" })).toHaveAttribute(
    "href",
    `/agents/${refFor("lead-ab12")}/usage`,
  );
  expect(within(spawned).getByText("Ended")).toBeInTheDocument();
});

test("switching to 7 days updates the URL and keeps the previous data while loading", async () => {
  let release: (() => void) | undefined;
  mockApi({
    [URL_PREFIX]: (_, url) => {
      if (daysOf(url) !== "7") return json(usage());
      return new Promise((resolve) => {
        release = () =>
          resolve(json(usage({ daily: daily(7), total: totals({ costUsd: 0.7, turns: 2 }) })));
      });
    },
  });
  const { router } = renderApp(`/agents/${refFor("lead")}/usage`, alice);
  await screen.findByText("$4.60");

  await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
  await waitFor(() => expect(router.state.location.search).toEqual({ days: 7 }));
  await waitFor(() => expect(release).toBeDefined());
  expect(screen.getByRole("radio", { name: "7 days" })).toBeChecked();
  expect(screen.getByText("$4.60")).toBeInTheDocument();

  release?.();
  expect(await screen.findByText("$0.70")).toBeInTheDocument();
  expect(screen.queryByText("$4.60")).not.toBeInTheDocument();
});

test("a spawned agent has no spawned section", async () => {
  mockApi({
    [`GET /api/agents/${refFor("lead-ab12")}/usage?`]: () =>
      json(
        usage({
          agent: {
            ref: refFor("lead-ab12"),
            handle: "lead-ab12",
            displayName: "Helper",
            kind: "ephemeral",
          },
          spawned: [],
        }),
      ),
  });
  renderApp(`/agents/${refFor("lead-ab12")}/usage`, alice);
  await screen.findByText("Estimated cost");
  expect(screen.queryByRole("heading", { name: "Spawned agents" })).not.toBeInTheDocument();
  expect(screen.queryByText(/^Own /)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "← @lead-ab12" })).toBeInTheDocument();
});

test("empty: no usage in the range", async () => {
  mockApi({
    [URL_PREFIX]: () =>
      json(
        usage({
          total: totals(),
          own: totals(),
          daily: daily(7, 0),
          byModel: [],
          byTask: [],
          spawned: [],
        }),
      ),
  });
  renderApp(`/agents/${refFor("lead")}/usage?days=7`, alice);
  expect(await screen.findByText("No usage in the last 7 days.")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "7 days" })).toBeChecked();
  expect(screen.queryByRole("table", { name: "By model" })).not.toBeInTheDocument();
});

test("error: a line with Retry that refetches", async () => {
  let fail = true;
  mockApi({
    "GET /api/principals": () => json({ principals: [principal(refFor("lead"), "lead")] }),
    [URL_PREFIX]: () =>
      fail ? json({ error: { code: "internal", message: "boom" } }, 500) : json(usage()),
  });
  renderApp(`/agents/${refFor("lead")}/usage`, alice);
  expect(await screen.findByText("Couldn't load usage for @lead.")).toBeInTheDocument();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("$4.60")).toBeInTheDocument();
});

test("an unknown ref renders the not-found state", async () => {
  mockApi({
    [`GET /api/agents/${refFor("nope")}/usage?`]: () =>
      json({ error: { code: "agent_not_found", message: "No agent named nope" } }, 404),
  });
  renderApp(`/agents/${refFor("nope")}/usage`, alice);
  expect(await screen.findByText("No agent at this link.")).toBeInTheDocument();
});
