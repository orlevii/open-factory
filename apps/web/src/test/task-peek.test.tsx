import type { ServerMessage } from "@open-factory/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, type MockApi, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onOpen?: () => void }) => {
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: (_: ServerMessage) => true };
  },
}));

const original = window.matchMedia;
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = original;
  vi.unstubAllGlobals();
});

const at = new Date(2026, 10, 19, 14, 0).toISOString();
const summary = (n: number) => ({
  key: `T-${n}`,
  title: `Task ${n}`,
  status: "open",
  assignee: null,
  blockedBy: [],
  createdBy: { kind: "user", handle: "or" },
  updatedAt: at,
});
const detail = (n: number) => ({
  ...summary(n),
  body: `Body of task ${n}`,
  createdAt: at,
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [],
  usage: null,
});
const KEYS = [1, 2, 3, 4, 5, 6];

let api: MockApi;
beforeEach(() => {
  api = mockApi({
    "GET /api/tasks?": () => json({ tasks: KEYS.map(summary), nextCursor: null }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
  });
  for (const n of KEYS) api.on(`GET /api/tasks/T-${n}`, () => json(detail(n)));
});

const row = (key: string) => document.querySelector<HTMLElement>(`a[data-task-key="${key}"]`);
const peek = () => screen.queryByRole("dialog");
const detailGets = (key: string) =>
  api.calls.filter((c) => c.method === "GET" && c.url === `/api/tasks/${key}`).length;

/** The Tasks page with the list `listPx` wide (jsdom has no layout: the width gate reads clientWidth). */
async function visit(listPx: number) {
  fakeMatchMedia.installWidth(1440);
  const app = renderApp("/tasks", alice);
  await waitFor(() => expect(row("T-1")).not.toBeNull());
  const list = screen.getByRole("list", { name: "Tasks" });
  Object.defineProperty(list, "clientWidth", { configurable: true, value: listPx });
  return app;
}
/** 54rem (24rem of list beside a 30rem sheet) at jsdom's 16px root. */
const GATE = 54 * 16;

const space = (el: HTMLElement) => fireEvent.keyDown(el, { key: " ", code: "Space" });

test("Space on a row peeks it in a non-modal sheet when the list keeps 54rem; focus stays on the row", async () => {
  const app = await visit(GATE);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  // fireEvent returns false when the press was preventDefault-ed (no page scroll).
  expect(space(r2)).toBe(false);
  const sheet = await screen.findByRole("dialog", { name: "T-2" });
  expect(sheet).not.toHaveAttribute("aria-modal");
  expect(app.router.state.location.pathname).toBe("/tasks");
  expect(document.activeElement).toBe(r2);
  expect(r2).toHaveAttribute("aria-current", "true");
  expect(row("T-1")).not.toHaveAttribute("aria-current");
  expect(within(sheet).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/tasks/T-2");
  expect(await within(sheet).findByText("Body of task 2")).toBeInTheDocument();
});

test("below the gate Space opens the task's page instead", async () => {
  const app = await visit(GATE - 1);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  expect(space(r2)).toBe(false);
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/tasks/T-2"));
  expect(peek()).toBeNull();
});

test("the gate reads the root font size: 54rem at a 20px root is 1080px", async () => {
  document.documentElement.style.fontSize = "20px";
  try {
    const app = await visit(1000);
    const r2 = row("T-2") as HTMLElement;
    r2.focus();
    space(r2);
    await waitFor(() => expect(app.router.state.location.pathname).toBe("/tasks/T-2"));
  } finally {
    document.documentElement.style.fontSize = "";
  }
});

test("j/k retarget the open peek in place: same sheet node, a fresh body, the selection follows", async () => {
  await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  space(r2);
  const sheet = await screen.findByRole("dialog", { name: "T-2" });
  const body = sheet.querySelector('[data-slot="sheet-body"]');
  // The peek isn't a modal: the list's j/k still run beside it.
  fireEvent.keyDown(r2, { key: "j" });
  expect(await screen.findByRole("dialog", { name: "T-3" })).toBe(sheet);
  expect(document.activeElement).toBe(row("T-3"));
  expect(row("T-3")).toHaveAttribute("aria-current", "true");
  expect(r2).not.toHaveAttribute("aria-current");
  // The body is keyed by task: a new node, so its scroll starts at the top.
  expect(sheet.querySelector('[data-slot="sheet-body"]')).not.toBe(body);
  expect(await within(sheet).findByText("Body of task 3")).toBeInTheDocument();
  fireEvent.keyDown(row("T-3") as HTMLElement, { key: "k" });
  expect(await screen.findByRole("dialog", { name: "T-2" })).toBe(sheet);
  // Arrow keys move focus only.
  fireEvent.keyDown(r2, { key: "ArrowDown" });
  expect(document.activeElement).toBe(row("T-3"));
  expect(screen.getByRole("dialog", { name: "T-2" })).toBe(sheet);
});

test("the open peek's neighbours are prefetched once the selection rests, not during a sweep", async () => {
  await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  vi.useFakeTimers();
  space(r2);
  await act(async () => vi.advanceTimersByTime(300));
  expect(detailGets("T-1")).toBe(1);
  expect(detailGets("T-3")).toBe(1);
  // A sweep to T-5: T-6 is nobody's shown row, and is fetched only after the rest.
  for (const k of ["T-3", "T-4"]) {
    fireEvent.keyDown(row(k) as HTMLElement, { key: "j" });
    await act(async () => vi.advanceTimersByTime(50));
  }
  expect(detailGets("T-6")).toBe(0);
  await act(async () => vi.advanceTimersByTime(300));
  expect(detailGets("T-6")).toBe(1);
});

test("Esc closes the peek at once and focuses the selected row, wherever focus was", async () => {
  await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  space(r2);
  fireEvent.keyDown(r2, { key: "j" });
  const sheet = await screen.findByRole("dialog", { name: "T-3" });
  within(sheet).getByRole("link", { name: "Open" }).focus();
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
  expect(sheet).toHaveAttribute("data-instant");
  await waitFor(() => expect(peek()).toBeNull());
  expect(document.activeElement).toBe(row("T-3"));
  expect(row("T-3")).not.toHaveAttribute("aria-current");
});

test("Space on the row the peek shows closes it and keeps focus on that row", async () => {
  const app = await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  space(r2);
  const sheet = await screen.findByRole("dialog", { name: "T-2" });
  expect(space(r2)).toBe(false);
  expect(sheet).toHaveAttribute("data-instant");
  await waitFor(() => expect(peek()).toBeNull());
  expect(document.activeElement).toBe(r2);
  expect(app.router.state.location.pathname).toBe("/tasks");
});

test("Space on a different row retargets the open peek in place: same sheet, a fresh body, scroll at the top", async () => {
  const app = await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  space(r2);
  const sheet = await screen.findByRole("dialog", { name: "T-2" });
  const body = sheet.querySelector('[data-slot="sheet-body"]');
  fireEvent.keyDown(r2, { key: "ArrowDown" });
  fireEvent.keyDown(row("T-3") as HTMLElement, { key: "ArrowDown" });
  const r4 = row("T-4") as HTMLElement;
  expect(document.activeElement).toBe(r4);
  expect(space(r4)).toBe(false);
  expect(await screen.findByRole("dialog", { name: "T-4" })).toBe(sheet);
  expect(sheet).not.toHaveAttribute("data-state", "closed");
  // Keyed by task: a new body node, so its scroll starts at the top.
  expect(sheet.querySelector('[data-slot="sheet-body"]')).not.toBe(body);
  expect(await within(sheet).findByText("Body of task 4")).toBeInTheDocument();
  expect(r4).toHaveAttribute("aria-current", "true");
  expect(r2).not.toHaveAttribute("aria-current");
  expect(document.activeElement).toBe(r4);
  expect(app.router.state.location.pathname).toBe("/tasks");
});

test("F6 moves focus from the list onto the peek's Open link", async () => {
  await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  space(r2);
  const sheet = await screen.findByRole("dialog", { name: "T-2" });
  fireEvent.keyDown(r2, { key: "F6" });
  expect(document.activeElement).toBe(within(sheet).getByRole("link", { name: "Open" }));
});

test("Esc with focus on the list closes the peek and keeps focus on the selected row", async () => {
  await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  space(r2);
  const sheet = await screen.findByRole("dialog", { name: "T-2" });
  fireEvent.keyDown(r2, { key: "Escape" });
  expect(sheet).toHaveAttribute("data-instant");
  await waitFor(() => expect(peek()).toBeNull());
  expect(document.activeElement).toBe(r2);
});

test("Esc inside the peek's editors leaves the peek open: the description draft survives, the title edit cancels", async () => {
  await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  space(r2);
  const sheet = await screen.findByRole("dialog", { name: "T-2" });
  await userEvent.click(await within(sheet).findByRole("button", { name: "Edit description" }));
  const area = within(sheet).getByRole("textbox", { name: "Description" });
  fireEvent.change(area, { target: { value: "A long draft" } });
  fireEvent.keyDown(area, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "T-2" })).toBe(sheet);
  expect(within(sheet).getByRole("textbox", { name: "Description" })).toHaveValue("A long draft");
  await userEvent.click(within(sheet).getByRole("button", { name: "Edit title" }));
  const title = within(sheet).getByRole("textbox", { name: "Title" });
  fireEvent.keyDown(title, { key: "Escape" });
  await waitFor(() => expect(within(sheet).queryByRole("textbox", { name: "Title" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "T-2" })).toBe(sheet);
});

test("changing the filters closes the peek", async () => {
  const app = await visit(1200);
  const r2 = row("T-2") as HTMLElement;
  r2.focus();
  space(r2);
  await screen.findByRole("dialog", { name: "T-2" });
  await act(async () => void app.router.navigate({ to: "/tasks", search: { status: "all" } }));
  await waitFor(() => expect(peek()).toBeNull());
});

test("a plain click and Enter open the task's page; no peek", async () => {
  const app = await visit(1200);
  fireEvent.click(row("T-2") as HTMLElement);
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/tasks/T-2"));
  expect(peek()).toBeNull();
  await act(async () => void app.router.navigate({ to: "/tasks" }));
  await waitFor(() => expect(row("T-4")).not.toBeNull());
  (row("T-4") as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(app.router.state.location.pathname).toBe("/tasks/T-4"));
  expect(peek()).toBeNull();
});

test("a keyboard sweep down the list fetches no task; hover still warms a row", async () => {
  await visit(1200);
  (row("T-1") as HTMLElement).focus();
  vi.useFakeTimers();
  const start = api.calls.length;
  const taskGets = () =>
    api.calls.slice(start).filter((c) => c.method === "GET" && /^\/api\/tasks\/T-\d$/.test(c.url));
  // A held j, then a held ↑ back up: focus passes every row (a slow key repeat, so each
  // focus could finish its preload).
  for (let n = 0; n < 5; n++) {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "j", repeat: n > 0 });
    await act(async () => vi.advanceTimersByTime(100));
  }
  expect(document.activeElement).toBe(row("T-6"));
  for (let n = 0; n < 5; n++) {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp", repeat: n > 0 });
    await act(async () => vi.advanceTimersByTime(100));
  }
  expect(document.activeElement).toBe(row("T-1"));
  await act(async () => vi.advanceTimersByTime(500));
  expect(taskGets()).toEqual([]);
  fireEvent.mouseEnter(row("T-3") as HTMLElement);
  await act(async () => vi.advanceTimersByTime(50));
  expect(taskGets().map((c) => c.url)).toEqual(["/api/tasks/T-3"]);
});
