import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, skill, source, sourceGroup } from "./fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ push: (_m: ServerMessage) => {} }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void }) => {
    ws.push = (m) => o.onMessage?.(m);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

beforeEach(() => fakeMatchMedia.install(false));
afterEach(() => vi.restoreAllMocks());

type Run = { checking?: boolean; updates?: number; failed?: number; adding?: boolean };

/** Twelve ready GitHub sources (plus one still being added): `checking` marks them all as the server does while a
 *  check runs; otherwise `updates` of them have an update and `failed` couldn't be reached. */
function twelve({ checking = false, updates = 0, failed = 0, adding = false }: Run = {}) {
  return library([
    hostGroup(),
    ...Array.from({ length: 12 }, (_, i) =>
      sourceGroup(
        source(`s${i}`, {
          checking: checking ? { since: "2026-11-24T10:00:00.000Z" } : null,
          update: i < updates,
          checkFailed: i >= updates && i < updates + failed,
        }),
        [skill(`k${i}`)],
      ),
    ),
    ...(adding
      ? [
          sourceGroup(
            source("new", { state: "adding", pin: null, since: "2026-11-24T10:00:00.000Z" }),
            [],
          ),
        ]
      : []),
  ]);
}

function serve(state: { data: unknown }) {
  return mockApi({
    "GET /api/library/skills": () => json(state.data),
    "POST /api/library/check": () => json({}, 202),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/h", sep: "/" }),
  });
}

/** The header's outcome line: the first live region (the reconnect strip is the other). */
const line = () => screen.getAllByRole("status")[0] as HTMLElement;

async function open(state: { data: unknown }) {
  const mocks = serve(state);
  renderApp("/skills", alice);
  await screen.findByRole("heading", { level: 1, name: "Skills" });
  return mocks;
}

test("the actions have accessible names", async () => {
  await open({ data: twelve() });
  expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Add skills" })).toBeEnabled();
});

/** The server marks every source as checking before the POST answers, and a frame follows each result. */
function checkingServer(state: { data: unknown }, done: Run, mocks: ReturnType<typeof serve>) {
  mocks.on("POST /api/library/check", () => {
    state.data = twelve({ checking: true, adding: done.adding });
    return json({}, 202);
  });
}

test("Check for updates posts the check; the line follows the sources' state from the server and ends with the outcome", async () => {
  const state = { data: twelve() as unknown };
  const mocks = await open(state);
  checkingServer(state, {}, mocks);
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(line()).toHaveTextContent("Checking…"));
  expect(
    mocks.calls.filter((c) => c.method === "POST" && c.url === "/api/library/check"),
  ).toHaveLength(1);
  // Still checking after a frame: the line stays.
  act(() => ws.push({ type: "library_changed" }));
  await new Promise((r) => setTimeout(r, 300));
  expect(line()).toHaveTextContent("Checking…");
  state.data = twelve({ updates: 2, failed: 1 });
  act(() => ws.push({ type: "library_changed" }));
  await waitFor(() =>
    expect(line()).toHaveTextContent("Checked 12 sources · 2 updates · 1 couldn't be reached"),
  );
});

test("when nothing has an update or failed, the line says all is up to date", async () => {
  const state = { data: twelve() as unknown };
  const mocks = await open(state);
  checkingServer(state, {}, mocks);
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(line()).toHaveTextContent("Checking…"));
  state.data = twelve();
  act(() => ws.push({ type: "library_changed" }));
  await waitFor(() => expect(line()).toHaveTextContent("All up to date · checked just now"));
});

test("a source still being added neither blocks the outcome nor counts as checked", async () => {
  const state = { data: twelve({ adding: true }) as unknown };
  const mocks = await open(state);
  checkingServer(state, { adding: true }, mocks);
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(line()).toHaveTextContent("Checking…"));
  state.data = twelve({ updates: 1, adding: true });
  act(() => ws.push({ type: "library_changed" }));
  await waitFor(() => expect(line()).toHaveTextContent("Checked 12 sources · 1 update"));
});

test("a check already running when the page loads shows its line, with nothing started here", async () => {
  await open({ data: twelve({ checking: true }) });
  expect(line()).toHaveTextContent("Checking…");
});

test("a failed check request says so in the line", async () => {
  const state = { data: twelve() as unknown };
  const mocks = await open(state);
  mocks.on("POST /api/library/check", () => json({ error: { code: "x", message: "boom" } }, 500));
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText("Couldn't check for updates.")).toBeInTheDocument();
});

test("'2 updates' moves focus to the first source with an update", async () => {
  const state = { data: twelve() as unknown };
  const mocks = await open(state);
  checkingServer(state, {}, mocks);
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(line()).toHaveTextContent("Checking…"));
  state.data = twelve({ updates: 2 });
  act(() => ws.push({ type: "library_changed" }));
  await userEvent.click(await screen.findByRole("button", { name: /^2\s+updates$/ }));
  expect(screen.getByRole("button", { name: /acme\/s0/ })).toHaveFocus();
});
