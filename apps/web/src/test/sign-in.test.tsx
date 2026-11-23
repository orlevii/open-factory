import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signIn: { email: vi.fn() },
}));
vi.mock("@/lib/auth-client", () => ({ authClient: auth }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

let bootstrap = true;

beforeEach(() => {
  auth.getSession.mockReset();
  auth.signIn.email.mockReset();
  bootstrap = true;
  mockApi({ "GET /api/auth/sign-up-state": () => json({ bootstrap, invite: "missing" }) });
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
  expect(await screen.findByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/sign-up");
  expect(screen.getByLabelText("Email")).toHaveFocus();
});

test("the Sign up link is hidden unless the factory is in bootstrap", async () => {
  bootstrap = false;
  renderApp("/sign-in", null);
  await screen.findByLabelText("Email");
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.queryByRole("link", { name: "Sign up" })).not.toBeInTheDocument();
  expect(screen.queryByText("No account yet?")).not.toBeInTheDocument();
});

test("USER_DISABLED shows the disabled line", async () => {
  auth.signIn.email.mockResolvedValue({
    data: null,
    error: { code: "USER_DISABLED", message: "This account is disabled.", status: 403 },
  });
  renderApp("/sign-in", null);
  await signIn("alice@example.com", "password123");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This account is disabled. Ask a member of this factory to enable it.",
  );
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

test("a successful sign-in lands on the Inbox", async () => {
  auth.signIn.email.mockResolvedValue({ data: { user: alice.user }, error: null });
  auth.getSession.mockResolvedValue({ data: alice });
  const { router } = renderApp("/sign-in", null);
  await signIn("alice@example.com", "password123");
  await waitFor(() => expect(router.state.location.pathname).toBe("/inbox"));
  expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
});

test("tabbing through an empty form shows no error", async () => {
  renderApp("/sign-in", null);
  const user = userEvent.setup();
  await screen.findByLabelText("Email");
  await user.tab();
  await user.tab();
  await user.tab();
  expect(screen.getByLabelText("Email")).not.toHaveAttribute("aria-invalid");
  expect(screen.getByLabelText("Password")).not.toHaveAttribute("aria-invalid");
});

test("an invalid email shows its error on blur and clears on the keystroke that fixes it", async () => {
  renderApp("/sign-in", null);
  const user = userEvent.setup();
  const email = await screen.findByLabelText("Email");
  await user.type(email, "nope");
  await user.tab();
  expect(email).toHaveAccessibleDescription("Enter a valid email");
  await user.click(email);
  await user.type(email, "@x.io");
  expect(email).not.toHaveAttribute("aria-invalid");
});

test("submitting empty focuses Email and does not call the server", async () => {
  renderApp("/sign-in", null);
  const user = userEvent.setup();
  await screen.findByLabelText("Email");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByLabelText("Email")).toHaveFocus();
  expect(auth.signIn.email).not.toHaveBeenCalled();
});

test("a repeated identical failure announces again with a new text node", async () => {
  auth.signIn.email.mockResolvedValue({
    data: null,
    error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid", status: 401 },
  });
  renderApp("/sign-in", null);
  await signIn("alice@example.com", "password123");
  const first = await screen.findByText("Wrong email or password.");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(auth.signIn.email).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByText("Wrong email or password.")).not.toBe(first));
  expect(screen.getByRole("alert")).toHaveTextContent("Wrong email or password.");
});
