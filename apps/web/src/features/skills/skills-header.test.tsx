import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor } from "@testing-library/react";
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

/** Twelve GitHub sources; once checked, `updates` of them have an update and `failed` couldn't be reached. */
function twelve(checkedAt: string | null, updates = 0, failed = 0) {
  return library([
    hostGroup(),
    ...Array.from({ length: 12 }, (_, i) =>
      sourceGroup(
        source(`s${i}`, {
          checkedAt,
          update: i < updates,
          checkFailed: i >= updates && i < updates + failed,
        }),
        [skill(`k${i}`)],
      ),
    ),
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

test("there is no view switch in this release", async () => {
  await open({ data: twelve(null) });
  expect(screen.queryByRole("navigation", { name: /views/i })).toBeNull();
});

test("the actions have accessible names", async () => {
  await open({ data: twelve(null) });
  expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Add skills" })).toBeEnabled();
});

test("Check for updates posts the check, then the outcome line is read from the sources' results", async () => {
  const state = { data: twelve("2026-11-24T10:00:00.000Z") };
  const mocks = await open(state);
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() =>
    expect(
      mocks.calls.filter((c) => c.method === "POST" && c.url === "/api/library/check"),
    ).toHaveLength(1),
  );
  await waitFor(() => expect(line()).toHaveTextContent("Checking…"));
  // The server finishes: each source's check result changed, and a frame says so.
  state.data = twelve("2026-11-24T10:05:00.000Z", 2, 1);
  act(() => ws.push({ type: "library_changed" }));
  await waitFor(() =>
    expect(line()).toHaveTextContent("Checked 12 sources · 2 updates · 1 couldn't be reached"),
  );
});

test("when nothing has an update or failed, the line says all is up to date", async () => {
  const state = { data: twelve("2026-11-24T10:00:00.000Z") };
  await open(state);
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  state.data = twelve("2026-11-24T10:05:00.000Z");
  act(() => ws.push({ type: "library_changed" }));
  await waitFor(() => expect(line()).toHaveTextContent("All up to date · checked just now"));
});

test("a failed check request says so in the line, never as a toast", async () => {
  const state = { data: twelve(null) };
  const mocks = await open(state);
  mocks.on("POST /api/library/check", () => json({ error: { code: "x", message: "boom" } }, 500));
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText("Couldn't check for updates.")).toBeInTheDocument();
});

test("'2 updates' moves focus to the first source with an update", async () => {
  const state = { data: twelve("2026-11-24T10:00:00.000Z") };
  await open(state);
  await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  state.data = twelve("2026-11-24T10:05:00.000Z", 2, 0);
  act(() => ws.push({ type: "library_changed" }));
  await userEvent.click(await screen.findByRole("button", { name: /^2\s+updates$/ }));
  expect(screen.getByRole("button", { name: /acme\/s0/ })).toHaveFocus();
});
