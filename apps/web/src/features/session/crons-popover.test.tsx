import type { AgentSummary } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { browserZone } from "@/features/schedules/format";
import { json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { agentSummary } from "@/test/session-fixtures";
import { CronsSegment } from "./crons-popover";
import { CronsStopLayer, useStopCrons } from "./stop-crons";

/** The segment as Agent details shows it, with the session view's Stop crons state and layer. */
function Segment({ agent }: { agent: AgentSummary }) {
  const stop = useStopCrons(agent);
  return (
    <>
      <CronsSegment agent={agent} stop={stop} />
      <CronsStopLayer agent={agent} stop={stop} />
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T10:00:00Z"));
});
afterEach(() => {
  // Radix can leave its modal marks on <body> when a test ends with a dialog closing.
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const crons = [
  {
    cronId: "c1",
    humanSchedule: "every 5 minutes",
    recurring: true,
    durable: false,
    expiresAt: "2026-11-27T10:00:00.000Z",
  },
  {
    cronId: "c2",
    humanSchedule: "at 14:30",
    recurring: false,
    durable: true,
    nextFireAt: "2026-11-20T13:30:00.000Z",
  },
];
function strip(over: Record<string, unknown> = {}) {
  const agent = agentSummary({
    slug: "dev",
    crons,
    waitingOn: { tasks: [], crons: 2 },
    cronZone: "Mars/Zone",
    ...over,
  } as never);
  const root = createRootRoute({
    component: () => (
      <div>
        <Segment agent={agent} />
        <div id="composer">
          <textarea aria-label="composer" />
        </div>
      </div>
    ),
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([stub("/schedules"), stub("/agents/$ref"), stub("/tasks")]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test("the segment is a button that opens a labelled popover with each cron, the zone line and the Stop button", async () => {
  strip();
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: "2 crons: show and stop" }));
  const pop = await screen.findByRole("dialog", { name: "Crons in this session" });
  expect(within(pop).getByText("every 5 minutes")).toBeInTheDocument();
  expect(within(pop).getByText(/^expires /)).toBeInTheDocument();
  expect(within(pop).getByText(/, once/)).toBeInTheDocument();
  expect(within(pop).getByText(/^next /)).toBeInTheDocument();
  expect(within(pop).getByText("(kept on disk)")).toBeInTheDocument();
  expect(pop.textContent).toContain("Cron times are in the server's zone (Mars/Zone).");
  expect(pop.textContent).toContain(
    "They stop when the process stops. Stopping them hibernates @dev once its current work is done.",
  );
  expect(within(pop).getByRole("button", { name: "Stop 2 crons" })).toBeInTheDocument();
});

test("the zone line only shows when the viewer's zone differs from the agent's", async () => {
  strip({ cronZone: browserZone() });
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "2 crons: show and stop" }));
  const pop = await screen.findByRole("dialog", { name: "Crons in this session" });
  expect(pop.textContent).not.toContain("Cron times are in the server's zone");
});

// Before the tests that open the confirmation: an AlertDialog leaves its modal marks on the page in jsdom.
test("while the stop is pending the segment says so and the popover has no Stop button", async () => {
  strip({ stopCronsPending: true });
  const btn = await screen.findByRole("button", { name: "2 crons: show and stop" });
  expect(btn.textContent).toBe("2 crons · stopping when @dev's current work finishes");
  await userEvent.setup().click(btn);
  const pop = await screen.findByRole("dialog", { name: "Crons in this session" });
  expect(within(pop).queryByRole("button", { name: /^Stop/ })).toBeNull();
});

test("Stop closes the popover, opens the confirmation with Cancel focused, then stops and announces it", async () => {
  const api = mockApi({
    [`POST /api/agents/${refFor("dev")}/stop-crons`]: () => json({ status: "stopped" }),
  });
  strip();
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: "2 crons: show and stop" }));
  await u.click(await screen.findByRole("button", { name: "Stop 2 crons" }));
  const dlg = await screen.findByRole("alertdialog", { name: "Stop @dev's crons?" });
  expect(screen.queryByRole("dialog", { name: "Crons in this session" })).toBeNull();
  expect(dlg.textContent).toContain("These crons stop and can't be restored:");
  expect(dlg.textContent).toContain("every 5 minutes");
  expect(dlg.textContent).toContain("at 14:30, once");
  expect(dlg.textContent).toContain(
    "@dev hibernates now, or when its current work finishes, and is told you stopped them.",
  );
  await waitFor(() => expect(within(dlg).getByRole("button", { name: "Cancel" })).toHaveFocus());
  await u.click(within(dlg).getByRole("button", { name: "Stop 2 crons" }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.url === `/api/agents/${refFor("dev")}/stop-crons`)).toBe(true),
  );
  expect(await screen.findByText("Stopped @dev's crons.")).toBeInTheDocument();
});

test("the confirmation's focus return does nothing once the segment has unmounted", async () => {
  mockApi({ [`POST /api/agents/${refFor("dev")}/stop-crons`]: () => json({ status: "stopped" }) });
  // A composer outside the segment's tree, standing in for the next page's (or the next test's).
  const other = document.body.appendChild(document.createElement("div"));
  other.id = "composer";
  const textarea = other.appendChild(document.createElement("textarea"));
  onTestFinished(() => other.remove());
  const { unmount } = strip();
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: "2 crons: show and stop" }));
  await u.click(await screen.findByRole("button", { name: "Stop 2 crons" }));
  await u.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop 2 crons" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // Radix calls onCloseAutoFocus on a timer after the dialog unmounts, and the hook defers the
  // focus to the next frame: both land after this unmount.
  unmount();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  expect(textarea).not.toHaveFocus();
});

test("a pending stop is announced as pending; no_crons and stopping count as done; other failures stay in the dialog", async () => {
  const api = mockApi({
    [`POST /api/agents/${refFor("dev")}/stop-crons`]: () => json({ status: "pending" }),
  });
  strip();
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: "2 crons: show and stop" }));
  await u.click(await screen.findByRole("button", { name: "Stop 2 crons" }));
  await u.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop 2 crons" }),
  );
  expect(
    await screen.findByText("@dev's crons stop when its current work finishes."),
  ).toBeInTheDocument();
  api.on(`POST /api/agents/${refFor("dev")}/stop-crons`, () =>
    json({ error: { code: "no_crons", message: "x" } }, 409),
  );
  await u.click(await screen.findByRole("button", { name: "2 crons: show and stop" }));
  await u.click(await screen.findByRole("button", { name: "Stop 2 crons" }));
  await u.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop 2 crons" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  api.on(`POST /api/agents/${refFor("dev")}/stop-crons`, () =>
    json({ error: { code: "boom", message: "x" } }, 500),
  );
  await u.click(await screen.findByRole("button", { name: "2 crons: show and stop" }));
  await u.click(await screen.findByRole("button", { name: "Stop 2 crons" }));
  await u.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Stop 2 crons" }),
  );
  expect(await screen.findByText("Couldn't stop the crons. Try again.")).toBeInTheDocument();
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  // Leave nothing modal behind: an open Radix dialog would hide the next test's page from the queries.
  await u.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

test("the outcome stays while the crons are gone and clears when new ones appear", async () => {
  mockApi({ [`POST /api/agents/${refFor("dev")}/stop-crons`]: () => json({ status: "stopped" }) });
  const withCrons = (n: number) => agentSummary({ handle: "dev", crons: crons.slice(0, n) });
  const { result, rerender } = renderHook(({ agent }) => useStopCrons(agent), {
    initialProps: { agent: withCrons(2) },
  });
  await act(() => result.current.run());
  expect(result.current.outcome?.text).toBe("Stopped @dev's crons.");
  rerender({ agent: withCrons(0) });
  expect(result.current.outcome?.text).toBe("Stopped @dev's crons.");
  rerender({ agent: withCrons(1) });
  expect(result.current.outcome).toBeUndefined();
});

/** Crons that can end while the page is open; `clearLive` ends them. */
let clearLive = () => {};
function Live() {
  const [list, setList] = useState(crons);
  clearLive = () => setList([]);
  const agent = agentSummary({
    slug: "dev",
    crons: list,
    waitingOn: { tasks: [], crons: list.length },
  } as never);
  // As in the session view: the state and the confirmation outlive the segment.
  const stop = useStopCrons(agent);
  return (
    <div>
      {list.length > 0 && <CronsSegment agent={agent} stop={stop} />}
      <CronsStopLayer agent={agent} stop={stop} />
      <div id="composer">
        <textarea aria-label="composer" />
      </div>
    </div>
  );
}

test("when the segment's Stop is gone as the confirmation closes, focus goes to the composer", async () => {
  mockApi({ [`POST /api/agents/${refFor("dev")}/stop-crons`]: () => json({ status: "stopped" }) });
  const root = createRootRoute({ component: Live });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/schedules", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const u = userEvent.setup();
  await u.click(await screen.findByRole("button", { name: "2 crons: show and stop" }));
  await u.click(await screen.findByRole("button", { name: "Stop 2 crons" }));
  await screen.findByRole("alertdialog");
  // The crons end while the confirmation is open: the segment (and its Stop) unmount with them.
  act(() => clearLive());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(screen.getByRole("textbox", { name: "composer" })).toHaveFocus());
});
