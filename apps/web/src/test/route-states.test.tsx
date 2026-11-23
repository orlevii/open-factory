import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AppPending } from "@/components/route-states";
import { ShellContext } from "@/components/shell-context";
import { alice, renderApp } from "@/test/render-app";

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: auth }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

beforeEach(() => auth.getSession.mockReset());
afterEach(() => vi.useRealTimers());

const failed = (status: number) => ({
  data: null,
  error: { status, statusText: "Bad Gateway", message: "" },
});
/** Runs the guard's retry backoff (1s, 2s, 4s, 8s) on a faked clock. */
const runBackoff = () => act(() => vi.advanceTimersByTimeAsync(16_000));

test("a slow session check shows the pilot-light pending screen", async () => {
  let resolve: (v: unknown) => void = () => {};
  auth.getSession.mockReturnValue(new Promise((r) => (resolve = r)));
  renderApp("/", undefined);
  const pending = await screen.findByRole("status", {}, { timeout: 2_000 });
  expect(pending).toHaveTextContent("Loading…");
  expect(pending).toHaveClass("is-loading");
  expect(screen.getAllByRole("main")).toHaveLength(1);
  resolve({ data: alice });
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
});

test("a fast session check never shows the pending screen", async () => {
  auth.getSession.mockResolvedValue({ data: alice });
  renderApp("/", undefined);
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
  expect(screen.queryByText("Loading…")).toBeNull();
});

test("a session check that fails while the server restarts retries under the pending mark, then loads", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  auth.getSession
    .mockResolvedValueOnce(failed(502))
    .mockResolvedValueOnce(failed(502))
    .mockResolvedValue({ data: alice });
  renderApp("/", undefined);
  await runBackoff();
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Something went wrong." })).toBeNull();
  expect(auth.getSession).toHaveBeenCalledTimes(3);
});

test("a failed session check shows the error state once its retries run out; Retry recovers", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  auth.getSession.mockResolvedValue({
    data: null,
    error: { status: 500, statusText: "Internal Server Error", message: "boom" },
  });
  renderApp("/", undefined);
  await runBackoff();
  expect(auth.getSession).toHaveBeenCalledTimes(5);
  expect(await screen.findByRole("heading", { name: "Something went wrong." })).toBeInTheDocument();
  expect(screen.getByText(/Session check failed: 500 boom/)).toBeInTheDocument();
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(document.title).toBe("Something went wrong · Open Factory");

  auth.getSession.mockResolvedValue({ data: alice });
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
});

test("AppPending inside the shell stays in the content area; at the root it covers the page", () => {
  const inShell = render(
    <ShellContext.Provider value={{ connectionLost: false }}>
      <AppPending />
    </ShellContext.Provider>,
  );
  const shellStatus = screen.getByRole("status");
  // The shell owns the one <main>: no second landmark inside it.
  expect(screen.queryByRole("main")).toBeNull();
  expect(shellStatus).toHaveClass("absolute", "inset-0");
  expect(shellStatus).not.toHaveClass("fixed");
  inShell.unmount();
  render(<AppPending />);
  const rootStatus = screen.getByRole("status");
  // At the root there is no shell: the page still needs its one <main>, around the cover.
  expect(screen.getByRole("main")).toContainElement(rootStatus);
  expect(rootStatus).toHaveClass("fixed", "inset-0");
  expect(rootStatus).not.toHaveClass("absolute");
});
