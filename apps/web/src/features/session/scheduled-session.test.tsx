import type { AnyEvent, QueueItem } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { closeSheet, getSheetState } from "@/features/sheets/sheet-store";
import { json, mockApi } from "@/test/mock-api";
import { envelope, resetSeq, se } from "@/test/session-fixtures";
import { QueueItems } from "./queue-items";
import { buildRows } from "./rows";
import { buildSpeakerIndex, SpeakerContext } from "./speaker-line";
import { TimelineRow } from "./timeline-row";

beforeEach(() => {
  resetSeq();
  mockApi({
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0 } }),
  });
});
afterEach(() => vi.unstubAllGlobals());

function inRouter(ui: React.ReactNode) {
  const root = createRootRoute({ component: () => <>{ui}</> });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([stub("/agents/$slug"), stub("/tasks/$key")]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const scheduled = (o: Record<string, unknown> = {}): AnyEvent => ({
  type: "message_in",
  messages: [
    envelope({
      id: "m1",
      from: "@scheduler",
      fromKind: "factory",
      kind: "scheduled",
      urgent: false,
      body: "Morning review",
      scheduleKey: "S-3",
      by: "@or",
      byKind: "human",
      due: "2026-11-23T09:00:00+01:00",
      ...o,
    }),
  ],
});
const speakers = buildSpeakerIndex({
  live: [
    {
      slug: "lead",
      displayName: "Lead",
      template: "lead",
      kind: "persistent",
      avatarVersion: null,
    },
  ],
});
function renderEvents(events: AnyEvent[]) {
  const { rows } = buildRows(events.map((e) => se(e, null)));
  return inRouter(
    <SpeakerContext value={speakers}>
      {rows.map((row) => (
        <div key={row.key} data-row>
          <TimelineRow
            slug="dev"
            row={row}
            expanded={new Set()}
            toggle={() => {}}
            rowProps={() => ({})}
            failedIds={new Set()}
            interruptedEnds={new Set()}
          />
        </div>
      ))}
    </SpeakerContext>,
  );
}

test("a delivered scheduled block: Scheduler, the S-3 badge opening the schedule's sheet, by @or, no notes when on time", async () => {
  const { container } = renderEvents([scheduled()]);
  expect(await screen.findByText("Scheduler")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Schedule S-3" }));
  expect(getSheetState().parent).toMatchObject({ kind: "edit-schedule", key: "S-3" });
  act(() => closeSheet());
  expect(container.textContent).toContain("by @or");
  expect(container.textContent).not.toContain("delivered late");
  expect(container.textContent).not.toContain("covers");
});

test("late and firings add the notes; an agent author links to its session", async () => {
  const { container } = renderEvents([
    scheduled({ late: true, firings: 3, by: "@lead", byKind: "agent" }),
  ]);
  await screen.findByText("Scheduler");
  expect(container.textContent).toContain(
    "due Mon 23 Nov 09:00 UTC+01:00 · delivered late · covers 3 runs",
  );
  expect(screen.getByRole("link", { name: /lead/ })).toHaveAttribute("href", "/agents/lead/chat");
});

test("an ended agent author, named by byKind, still reads as an agent (a chip, not a plain handle)", async () => {
  renderEvents([scheduled({ by: "@gone-ab12", byKind: "agent" })]);
  await screen.findByText("Scheduler");
  expect(screen.getByRole("link", { name: /gone-ab12/ })).toHaveAttribute(
    "href",
    "/agents/gone-ab12/chat",
  );
});

test("a human author stays a plain handle even when the list is not loaded", async () => {
  const { container } = renderEvents([scheduled({ by: "@or", byKind: "human" })]);
  await screen.findByText("Scheduler");
  expect(container.textContent).toContain("by @or");
  expect(screen.queryByRole("link", { name: /@or/ })).toBeNull();
});

test("a pending scheduled item shows the badge and 'covers 3 runs'", async () => {
  const item: QueueItem = {
    id: "q1",
    kind: "message",
    from: "@scheduler",
    fromKind: "factory",
    body: "Check the build",
    scheduleKey: "S-5",
    firings: 3,
    createdAt: "2026-11-23T08:00:00.000Z",
  };
  const { container } = inRouter(
    <QueueItems items={[item]} agent={{ slug: "dev", status: "errored" } as never} />,
  );
  expect(await screen.findByRole("button", { name: "Schedule S-5" })).toBeInTheDocument();
  expect(container.textContent).toContain("Scheduler");
  expect(container.textContent).toContain("covers 3 runs");
});

test("the three quiet lines read as specified, from the events' `by` and `durable`", async () => {
  const { container } = renderEvents([
    { type: "hibernated", reason: "crons_stopped", by: "@or" },
    {
      type: "background_work_lost",
      reason: "crons_stopped",
      by: "@or",
      tasks: [],
      crons: [{ cronId: "c1", humanSchedule: "Every 5 minutes" }],
    },
    {
      type: "cron_created",
      cronId: "c2",
      recurring: true,
      humanSchedule: "Every 5 minutes",
      nextFireAt: 1,
      durable: true,
    },
  ]);
  await screen.findByText(/Hibernated: @or stopped its crons/);
  expect(container.textContent).toContain("Stopped by @or: every 5 minutes (cron)");
  expect(container.textContent).toContain("Cron created: every 5 minutes (kept on disk)");
});

test("escaping: a hostile body goes through the sanitized Markdown renderer; HTML stays text", async () => {
  const alert = vi.fn();
  vi.stubGlobal("alert", alert);
  const { container } = renderEvents([
    scheduled({
      body: "**bold** <img src=x onerror=alert(1)> <script>alert(2)</script> [x](javascript:alert(3))",
    }),
  ]);
  await screen.findByText("Scheduler");
  expect(container.querySelector("strong")?.textContent).toBe("bold"); // markdown formats
  expect(container.querySelector("img, script")).toBeNull();
  expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(
    [...container.querySelectorAll("a")].some((a) =>
      a.getAttribute("href")?.startsWith("javascript:"),
    ),
  ).toBe(false);
  expect(alert).not.toHaveBeenCalled();
});
