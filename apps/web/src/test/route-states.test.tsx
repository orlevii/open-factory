import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppPending } from "@/components/route-states";
import { ShellContext } from "@/components/shell-context";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

/** What `GET /api/me` answers next. */
const me = vi.fn<() => Response | Promise<Response>>();
beforeEach(() => {
  me.mockReset();
  mockApi({ "GET /api/me": () => me() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const failed = (status: number, message = "") =>
  json({ error: { code: "upstream", message } }, status);
const signedIn = () => json(alice.user);
/** Runs the guard's retry backoff (1s, 2s, 4s, 8s) on a faked clock. */
const runBackoff = () => act(() => vi.advanceTimersByTimeAsync(16_000));

test("a slow session check shows the pending screen", async () => {
  let resolve: (v: Response) => void = () => {};
  me.mockReturnValue(new Promise((r) => (resolve = r)));
  renderApp("/", undefined);
  const pending = await screen.findByRole("status", {}, { timeout: 2_000 });
  expect(pending).toHaveTextContent("Loading…");
  expect(screen.getAllByRole("main")).toHaveLength(1);
  resolve(signedIn());
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
});

test("a fast session check never shows the pending screen", async () => {
  me.mockImplementation(signedIn);
  renderApp("/", undefined);
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
  expect(screen.queryByText("Loading…")).toBeNull();
});

test("a session check that fails while the server restarts retries under the pending mark, then loads", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  me.mockResolvedValueOnce(failed(502))
    .mockResolvedValueOnce(failed(502))
    .mockImplementation(signedIn);
  renderApp("/", undefined);
  await runBackoff();
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Something went wrong." })).toBeNull();
  expect(me).toHaveBeenCalledTimes(3);
});

test("a failed session check shows the error state once its retries run out; Retry recovers", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  me.mockImplementation(() => failed(500, "boom"));
  renderApp("/", undefined);
  await runBackoff();
  expect(me).toHaveBeenCalledTimes(5);
  expect(await screen.findByRole("heading", { name: "Something went wrong." })).toBeInTheDocument();
  expect(screen.getByText(/Session check failed: 500 boom/)).toBeInTheDocument();
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(document.title).toBe("Something went wrong · Open Factory");

  me.mockImplementation(signedIn);
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
});

test("AppPending inside the shell adds no second main landmark; at the root it brings its own", () => {
  const inShell = render(
    <ShellContext.Provider value={{ connectionLost: false }}>
      <AppPending />
    </ShellContext.Provider>,
  );
  expect(screen.getByRole("status")).toBeInTheDocument();
  // The shell owns the one <main>: no second landmark inside it.
  expect(screen.queryByRole("main")).toBeNull();
  inShell.unmount();
  render(<AppPending />);
  const rootStatus = screen.getByRole("status");
  // At the root there is no shell: the page still needs its one <main>, around the cover.
  expect(screen.getByRole("main")).toContainElement(rootStatus);
});
