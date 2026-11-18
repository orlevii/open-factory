import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";

const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: auth }));
vi.mock("@/lib/ws", () => ({ connectWs: () => ({ close() {}, status: () => "open" }) }));

beforeEach(() => auth.getSession.mockReset());

test("a slow session check shows the pilot-light pending screen", async () => {
  let resolve: (v: unknown) => void = () => {};
  auth.getSession.mockReturnValue(new Promise((r) => (resolve = r)));
  renderApp("/", undefined);
  const pending = await screen.findByRole("status", {}, { timeout: 2_000 });
  expect(pending).toHaveTextContent("Loading…");
  expect(pending).toHaveClass("is-loading");
  expect(screen.getAllByRole("main")).toHaveLength(1);
  resolve({ data: alice });
  expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
});

test("a fast session check never shows the pending screen", async () => {
  auth.getSession.mockResolvedValue({ data: alice });
  renderApp("/", undefined);
  expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  expect(screen.queryByText("Loading…")).toBeNull();
});

test("a failed session check shows the error state; Retry recovers", async () => {
  auth.getSession.mockResolvedValue({
    data: null,
    error: { status: 500, statusText: "Internal Server Error", message: "boom" },
  });
  renderApp("/", undefined);
  expect(await screen.findByRole("heading", { name: "Something went wrong." })).toBeInTheDocument();
  expect(screen.getByText(/Session check failed: 500 boom/)).toBeInTheDocument();
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(document.title).toBe("Something went wrong · Open Factory");

  auth.getSession.mockResolvedValue({ data: alice });
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
});
