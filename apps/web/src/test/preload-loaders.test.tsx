import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { closeSheet } from "@/features/sheets/sheet-store";
import { json, mockApi } from "@/test/mock-api";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

const at = "2026-11-19T09:10:00.000Z";
const agents = () =>
  json({ agents: [agentSummary({ handle: "ceo" })], more: false, running: { count: 0 } });
const user = { kind: "human", ref: refFor("or"), handle: "or" };
const taskRow = {
  key: "T-1",
  title: "Task one",
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: user,
  updatedAt: at,
};
const taskDetail = {
  ...taskRow,
  body: "",
  createdAt: at,
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [],
  usage: null,
};
const schedule = {
  key: "S-1",
  target: {
    ref: refFor("ceo"),
    handle: "ceo",
    displayName: "CEO",
    archived: false,
    terminated: false,
  },
  cron: "0 9 * * 1-5",
  timezone: "Europe/Berlin",
  body: "Morning review",
  nextRunAt: "2099-11-23T08:00:00.000Z",
  lastFiredAt: null,
  paused: false,
  done: false,
  createdBy: user,
  bodyAuthor: user,
  pendingFiring: false,
  state: "active",
};

/** The click has navigated and the destination's loader and first render have had time to fetch. */
const settled = async (router: { state: { location: { pathname: string } } }, path: string) => {
  await waitFor(() => expect(router.state.location.pathname).toBe(path));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
};

const hoverThenClick = async (link: HTMLElement) => {
  fireEvent.mouseEnter(link);
  fireEvent.focus(link);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  fireEvent.click(link);
};

test("hovering a task link then clicking it fetches the detail once", async () => {
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/tasks?": () => json({ tasks: [taskRow], nextCursor: null }),
    "GET /api/tasks/T-1": () => json(taskDetail),
  });
  const { router } = renderApp("/tasks", alice);
  await hoverThenClick(await screen.findByRole("link", { name: /Task one/ }));
  await settled(router, "/tasks/T-1");
  expect(api.calls.filter((c) => c.url === "/api/tasks/T-1")).toHaveLength(1);
});

test("hovering a schedule row then clicking it fetches the detail once, for the sheet", async () => {
  const list = () => json({ schedules: [schedule], more: false });
  const api = mockApi({
    "GET /api/agents?": agents,
    "GET /api/schedules?": list,
    "GET /api/schedules": list,
    "GET /api/schedules/S-1": () => json({ schedule }),
  });
  renderApp("/schedules", alice);
  const key = await screen.findByRole("button", { name: /^S-1,/ });
  fireEvent.pointerEnter(key);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
  fireEvent.click(key);
  expect(await screen.findByRole("dialog", { name: "S-1" })).toBeInTheDocument();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(api.calls.filter((c) => c.url === "/api/schedules/S-1")).toHaveLength(1);
  act(() => closeSheet());
});
