import { screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({
  authClient: { getSession: vi.fn(async () => ({ data: null })) },
}));
const connectWs = vi.hoisted(() => vi.fn(() => ({ close: vi.fn(), status: () => "open" })));
vi.mock("@/lib/ws", () => ({ connectWs }));

beforeEach(() => connectWs.mockClear());

test.each(["/", "/agents", "/settings"])("signed out, %s redirects to /sign-in", async (path) => {
  const { router } = renderApp(path, null);
  await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  expect(connectWs).not.toHaveBeenCalled();
});

test.each(["/sign-in", "/sign-up"])("signed in, %s redirects to /", async (path) => {
  const { router } = renderApp(path, alice);
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
});

test("signed in, the layout opens the websocket and shows the user menu", async () => {
  renderApp("/", alice);
  expect(await screen.findByText("@alice")).toBeInTheDocument();
  expect(screen.getByText("Alice")).toBeInTheDocument();
  expect(connectWs).toHaveBeenCalledOnce();
});
