import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signIn: { email: vi.fn() },
}));
vi.mock("@/lib/auth-client", () => ({ authClient: auth }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

beforeEach(() => {
  auth.getSession.mockReset();
  auth.signIn.email.mockReset();
});

async function signIn(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

test("the page shows the wordmark, the title and a link to sign up", async () => {
  renderApp("/sign-in", null);
  expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Open Factory" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up");
  expect(screen.getByLabelText("Email")).toHaveFocus();
});

test("wrong credentials are a form-level alert", async () => {
  auth.signIn.email.mockResolvedValue({
    data: null,
    error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid", status: 401 },
  });
  renderApp("/sign-in", null);
  await signIn("alice@example.com", "password123");
  expect(await screen.findByRole("alert")).toHaveTextContent("Wrong email or password.");
});

test("an unreachable server shows the network message", async () => {
  auth.signIn.email.mockRejectedValue(new TypeError("Failed to fetch"));
  renderApp("/sign-in", null);
  await signIn("alice@example.com", "password123");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Can't reach the server. Check that it's running, then try again.",
  );
});

test("a proxy's 502 with no error code also counts as unreachable", async () => {
  auth.signIn.email.mockResolvedValue({
    data: null,
    error: { status: 502, statusText: "Bad Gateway" },
  });
  renderApp("/sign-in", null);
  await signIn("alice@example.com", "password123");
  expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach the server.");
});

test("the button shows the pending label while the request runs", async () => {
  let resolve: (v: unknown) => void = () => {};
  auth.signIn.email.mockReturnValue(new Promise((r) => (resolve = r)));
  renderApp("/sign-in", null);
  await signIn("alice@example.com", "password123");
  expect(await screen.findByRole("button", { name: "Signing in…" })).toBeDisabled();
  resolve({ data: null, error: { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 } });
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("a successful sign-in lands on the dashboard", async () => {
  auth.signIn.email.mockResolvedValue({ data: { user: alice.user }, error: null });
  auth.getSession.mockResolvedValue({ data: alice });
  const { router } = renderApp("/sign-in", null);
  await signIn("alice@example.com", "password123");
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
});
