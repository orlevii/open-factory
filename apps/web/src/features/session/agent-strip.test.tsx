import type { AgentSummary } from "@open-factory/shared";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { agentSummary } from "@/test/session-fixtures";
import { AgentStrip } from "./agent-strip";

// The manager is a router link; the real link is covered in the full-app tests (messaging.test.tsx).
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a href="/" className={className}>
      {children}
    </a>
  ),
}));

const NOW = new Date(2026, 10, 19, 10, 0);
const todayAt = (h: number, m: number) => new Date(2026, 10, 19, h, m).toISOString();
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const strip = (over: Partial<AgentSummary> = {}, slotsMax?: number) => {
  render(<AgentStrip agent={agentSummary(over)} slotsMax={slotsMax} />);
  return document.querySelector("[data-agent-strip]") as HTMLElement;
};
const liveRegion = (el: HTMLElement) => el.querySelector("[role=status]") as HTMLElement;

test("strip: Waiting on with truncated aria-hidden text and full visually hidden text; outside the role=status region", () => {
  const long = "pnpm test --filter @open-factory/server --reporter verbose";
  const el = strip({
    waitingOn: { tasks: [{ taskId: "t1", description: long, startedAt: minutesAgo(3) }], crons: 2 },
  });
  const waiting = el.querySelector("[data-waiting-on]") as HTMLElement;
  expect(waiting).not.toBeNull();
  expect(liveRegion(el).contains(waiting)).toBe(false);
  const visible = within(waiting).getByText(`${long.slice(0, 40).trimEnd()}…`);
  expect(visible).toHaveAttribute("aria-hidden", "true");
  expect(within(waiting).getByText(long)).toHaveClass("sr-only");
  expect(waiting).not.toHaveAttribute("title");
  expect(waiting.textContent).toBe(
    `Waiting on: ${long.slice(0, 40).trimEnd()}…${long} (background, 3m) · 2 crons`,
  );
});

test("strip: Waiting on refreshes the minutes each minute, real plurals, and 'and N more'", () => {
  const tasks = ["pnpm test", "pnpm build", "vite", "tsc"].map((d, i) => ({
    taskId: `t${i}`,
    description: d,
    startedAt: minutesAgo(3),
  }));
  const el = strip({ waitingOn: { tasks, crons: 1 } });
  const waiting = () => (el.querySelector("[data-waiting-on]") as HTMLElement).textContent;
  expect(waiting()).toBe("Waiting on: pnpm test (background, 3m) and 3 more · 1 cron");
  // The faked clock moves with the timers.
  act(() => vi.advanceTimersByTime(60_000));
  expect(waiting()).toBe("Waiting on: pnpm test (background, 4m) and 3 more · 1 cron");
});

test("strip: two tasks are both listed; nothing when empty", () => {
  const el = strip({
    waitingOn: {
      tasks: [
        { taskId: "a", description: "pnpm test", startedAt: minutesAgo(3) },
        { taskId: "b", description: "vite", startedAt: minutesAgo(1) },
      ],
      crons: 0,
    },
  });
  expect((el.querySelector("[data-waiting-on]") as HTMLElement).textContent).toBe(
    "Waiting on: pnpm test (background, 3m) · vite (background, 1m)",
  );
  document.body.innerHTML = "";
  expect(strip().querySelector("[data-waiting-on]")).toBeNull();
});

test("strip: paused detail uses 'retrying at' when inexact; queued detail; Pulling the image…", () => {
  let el = strip({
    status: "rate_limited",
    credential: "work",
    rateLimitedUntil: todayAt(14, 30),
    rateLimitExact: true,
  });
  const exact = within(el).getByText(/^Paused:/);
  expect(exact.textContent).toBe(
    "Paused: credential work is rate-limited until 14:30. Messages wait until then.",
  );
  expect(within(exact).getByText("work")).toHaveClass("font-mono");
  expect(liveRegion(el).contains(exact)).toBe(false);
  document.body.innerHTML = "";
  el = strip({ status: "rate_limited", rateLimitedUntil: todayAt(14, 30), rateLimitExact: false });
  expect(within(el).getByText(/^Paused:/).textContent).toBe(
    "Paused: credential work is rate-limited, retrying at 14:30. Messages wait until then.",
  );
  document.body.innerHTML = "";
  el = strip({ status: "queued" });
  expect(within(el).queryByText(/^Queued:/)).toBeNull(); // no copy until the cap is known
  document.body.innerHTML = "";
  el = strip({ status: "queued" }, 8);
  expect(within(el).getByText("Queued: all 8 slots are in use.")).toBeInTheDocument();
  document.body.innerHTML = "";
  el = strip({ status: "queued", pulling: true, runtime: "docker" }, 8);
  expect(within(el).getByText("Pulling the image…")).toBeInTheDocument();
  expect(within(el).queryByText(/slots are in use/)).toBeNull();
  // Pulling shows even when a slot is free and the agent isn't queued.
  document.body.innerHTML = "";
  el = strip({ status: "hibernated", pulling: true, runtime: "docker" });
  expect(within(el).getByText("Pulling the image…")).toBeInTheDocument();
});

test("strip: Docker (open-factory-base:dev) / Docker / local disabled with its Why? (distinct aria-label)", async () => {
  let el = strip({ runtime: "docker", image: "open-factory-base:dev" });
  expect(el.textContent).toContain("Docker (open-factory-base:dev)");
  expect(within(el).getByText("open-factory-base:dev")).toHaveClass("font-mono");
  document.body.innerHTML = "";
  el = strip({ runtime: "docker" });
  expect(el.textContent).toMatch(/·Docker$/);
  document.body.innerHTML = "";
  el = strip({
    runtime: "local",
    runtimeDisabled: "The local runtime is disabled on this factory.",
    restartPending: true,
  });
  expect(within(el).getByText("Local runtime disabled on this factory")).toBeInTheDocument();
  expect(el.textContent).not.toMatch(/Unsandboxed/);
  const why = within(el).getByRole("button", { name: "Why is the local runtime disabled?" });
  expect(within(el).getByRole("button", { name: "Why does it restart?" })).toBeInTheDocument();
  await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(why);
  const pop = await screen.findByText(/An operator has to allow unsandboxed agents/);
  expect(pop.textContent).toBe(
    "An operator has to allow unsandboxed agents by setting FACTORY_ALLOW_LOCAL_RUNTIME=true. Until then this agent can't start.",
  );
  expect(within(pop).getByText("FACTORY_ALLOW_LOCAL_RUNTIME=true")).toHaveClass("font-mono");
});

test("strip: the restart Why? explains crons", async () => {
  const el = strip({ restartPending: true });
  await userEvent
    .setup({ advanceTimers: vi.advanceTimersByTime })
    .click(within(el).getByRole("button", { name: "Why does it restart?" }));
  expect(
    await screen.findByText(
      "The agent finishes its current turn and background tasks, then restarts with the new settings. Its session is kept. Its crons from this session stop, and it's told which, so it can recreate them.",
    ),
  ).toBeInTheDocument();
});

test("strip: a cap of one slot reads in the singular", () => {
  const el = strip({ status: "queued" }, 1);
  expect(within(el).getByText("Queued: the only slot is in use.")).toBeInTheDocument();
  expect(el.textContent).not.toMatch(/all 1 slots/);
});

test("strip: each Why? popover holds its explanation in one paragraph", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const el = strip({ runtime: "local", runtimeDisabled: "disabled", restartPending: true });
  await user.click(within(el).getByRole("button", { name: "Why is the local runtime disabled?" }));
  const local = await screen.findByText(/An operator has to allow unsandboxed agents/);
  expect(local.tagName).toBe("P");
  expect(local.parentElement?.children).toHaveLength(1);
  await user.keyboard("{Escape}");
  await user.click(within(el).getByRole("button", { name: "Why does it restart?" }));
  const restart = await screen.findByText(/The agent finishes its current turn/);
  expect(restart.tagName).toBe("P");
});

test("strip: the live region adds no layout item of its own, so an empty one leaves no double gap", () => {
  const el = strip({ waitingOn: { tasks: [], crons: 2 } });
  const region = liveRegion(el);
  expect(region).toBeEmptyDOMElement();
  expect(region).toHaveClass("contents");
  document.body.innerHTML = "";
  const filled = liveRegion(strip({ restartPending: true }));
  expect(filled).toHaveClass("contents");
  expect(filled.textContent).toBe("·Restarts when idle to apply changes");
});

test.each([
  [{ reportsTo: "lead", reports: 3 }, "Reports to @lead · 3 reports"],
  [{ reportsTo: "lead", reports: 0 }, "Reports to @lead"],
  [{ reportsTo: null, reports: 1 }, "No manager · 1 report"],
  [{ reportsTo: null, reports: 0 }, "No manager"],
])("org segment %o", (o, text) => {
  const el = strip(o);
  expect(el.querySelector("[data-strip-org]")?.textContent).toBe(text);
  expect(el.querySelector("[role=status] [data-strip-org]")).toBeNull(); // outside the live region
});

test("strip: a terminated agent shows no queued, paused or restart segment (S7: an end state)", () => {
  const el = strip({
    status: "terminated",
    restartPending: true,
    restartWaitingOn: 1,
    rateLimitedUntil: todayAt(14, 30),
  });
  expect(el.textContent).not.toMatch(/Queued|Paused|Restarts when idle/);
  expect(el.textContent).toContain("No manager");
});
