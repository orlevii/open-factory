import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signUp: { email: vi.fn() },
}));
vi.mock("@/lib/auth-client", () => ({ authClient: auth }));
vi.mock("@/lib/ws", () => ({ connectWs: () => ({ close() {}, status: () => "open" }) }));

beforeEach(() => {
  auth.getSession.mockReset();
  auth.signUp.email.mockReset();
});

async function fill(values: { name?: string; handle?: string; email?: string; password?: string }) {
  const user = userEvent.setup();
  if (values.name) await user.type(screen.getByLabelText("Name"), values.name);
  if (values.handle) await user.type(screen.getByLabelText("Handle"), values.handle);
  if (values.email) await user.type(screen.getByLabelText("Email"), values.email);
  if (values.password) await user.type(screen.getByLabelText("Password"), values.password);
  await user.click(screen.getByRole("button", { name: "Sign up" }));
}

const valid = {
  name: "Alice",
  handle: "alice",
  email: "alice@example.com",
  password: "password123",
};

test("the handle is lowercased as the user types", async () => {
  renderApp("/sign-up", null);
  await userEvent.type(await screen.findByLabelText("Handle"), "AliCe");
  expect(screen.getByLabelText("Handle")).toHaveValue("alice");
});

test("client-side validation shows errors per field and does not call the server", async () => {
  renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill({ handle: "me", email: "nope", password: "short" });
  expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(/.+/);
  expect(screen.getByLabelText("Handle")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
    "Password must be at least 8 characters",
  );
  expect(auth.signUp.email).not.toHaveBeenCalled();
});

test("HANDLE_TAKEN from the server is shown under the handle field", async () => {
  auth.signUp.email.mockResolvedValue({
    data: null,
    error: { code: "HANDLE_TAKEN", message: "Handle taken", status: 422 },
  });
  renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  await waitFor(() =>
    expect(screen.getByLabelText("Handle")).toHaveAccessibleDescription(
      "That handle is already taken.",
    ),
  );
  expect(auth.signUp.email).toHaveBeenCalledWith(valid);
});

test("an unknown server error is shown at form level", async () => {
  auth.signUp.email.mockResolvedValue({
    data: null,
    error: { code: "FAILED_TO_CREATE_USER", message: "Failed to create user", status: 422 },
  });
  renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  expect(await screen.findByRole("alert")).toHaveTextContent("Failed to create user");
});

test("a successful sign-up refreshes the session and lands on the dashboard", async () => {
  auth.signUp.email.mockResolvedValue({ data: { user: alice.user }, error: null });
  auth.getSession.mockResolvedValue({ data: alice });
  const { router } = renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  expect(auth.getSession).toHaveBeenCalled();
  expect(await screen.findByText("No agents yet.")).toBeInTheDocument();
});

test("the handle field has an @ adornment and help text that an error replaces", async () => {
  renderApp("/sign-up", null);
  const handle = await screen.findByLabelText("Handle");
  expect(handle).toHaveAccessibleDescription(
    "How agents mention you, like @alice. Lowercase letters, numbers and hyphens.",
  );
  expect(screen.getByText("@")).toHaveAttribute("aria-hidden", "true");
  await fill({ ...valid, handle: "x" });
  expect(handle).toHaveAttribute("aria-invalid", "true");
  expect(handle).not.toHaveAccessibleDescription(/How agents mention you/);
});

test("a failed submit moves focus to the first invalid field; editing clears its error", async () => {
  renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill({ name: "Alice", handle: "x", email: "nope", password: "password123" });
  const handle = screen.getByLabelText("Handle");
  expect(handle).toHaveFocus();
  await userEvent.type(handle, "y");
  expect(handle).not.toHaveAttribute("aria-invalid");
  expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
});

test("an unreachable server shows the network message at form level", async () => {
  auth.signUp.email.mockRejectedValue(new TypeError("Failed to fetch"));
  renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Can't reach the server. Check that it's running, then try again.",
  );
  expect(screen.getByRole("button", { name: "Sign up" })).toBeEnabled();
});
