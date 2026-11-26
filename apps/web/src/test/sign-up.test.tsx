import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signUp: { email: vi.fn() },
}));
vi.mock("@/lib/auth-client", () => ({ authClient: auth }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

type State = { bootstrap: boolean; invite: "valid" | "invalid" | "missing" };
let api: ReturnType<typeof mockApi>;
const serve = (state: State) => {
  api.on("GET /api/auth/sign-up-state", () => json(state));
  api.on("GET /api/auth/sign-up-state?", () => json(state));
};
/** What better-fetch resolves for the sign-up gate's 403: the parsed body `{ error: { code,
 *  message } }` (apps/server/src/users/sign-up-gate.ts) spread next to status and statusText. */
const gateError = (code: string, message: string) => ({
  data: null,
  error: { error: { code, message }, status: 403, statusText: "Forbidden" },
});

beforeEach(() => {
  auth.getSession.mockReset();
  auth.signUp.email.mockReset();
  api = mockApi({});
  serve({ bootstrap: true, invite: "missing" });
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
  expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter a valid email.");
  expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
    "Use at least 8 characters.",
  );
  expect(auth.signUp.email).not.toHaveBeenCalled();
});

test("HANDLE_TAKEN from the server is shown under the handle field, which takes focus", async () => {
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
  expect(screen.getByLabelText("Handle")).toHaveFocus();
  expect(auth.signUp.email).toHaveBeenCalledWith(valid);
});

test("an email that already has an account is shown under Email, which takes focus", async () => {
  auth.signUp.email.mockResolvedValue({
    data: null,
    error: {
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      message: "User already exists. Use another email.",
      status: 422,
    },
  });
  renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  const email = screen.getByLabelText("Email");
  await waitFor(() =>
    expect(email).toHaveAccessibleDescription("That email already has an account."),
  );
  expect(email).toHaveFocus();
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

test("a successful sign-up refreshes the session and lands on the Inbox", async () => {
  auth.signUp.email.mockResolvedValue({ data: { user: alice.user }, error: null });
  auth.getSession.mockResolvedValue({ data: alice });
  api.on("GET /api/agents?", () => json({ agents: [], more: false, running: { count: 0 } }));
  const { router } = renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  await waitFor(() => expect(router.state.location.pathname).toBe("/inbox"));
  expect(auth.getSession).toHaveBeenCalled();
  await screen.findByRole("heading", { level: 1, name: "Inbox" });
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
    "Couldn't reach the server. Try again.",
  );
  expect(screen.getByRole("button", { name: "Sign up" })).toBeEnabled();
});

const FIRST_USER =
  "You're the first user of this factory. You'll invite everyone else from Settings → Users.";
const MISSING = "Sign-up needs an invite from a member.";
const INVALID = "Invite isn't valid. Ask for a new one.";
const LOST_RACE = "Someone was first. Ask for an invite.";

test("bootstrap shows the form with the first-user line, and asks for the state without a query string", async () => {
  renderApp("/sign-up", null);
  expect(await screen.findByLabelText("Name")).toBeInTheDocument();
  expect(screen.getByText(FIRST_USER)).toBeInTheDocument();
  expect(api.calls[0]?.url).toBe("/api/auth/sign-up-state");
});

test("a valid invite shows the form and sends the invite with the sign-up", async () => {
  serve({ bootstrap: false, invite: "valid" });
  auth.signUp.email.mockResolvedValue({ data: { user: alice.user }, error: null });
  auth.getSession.mockResolvedValue({ data: alice });
  renderApp("/sign-up?invite=tok_1", null);
  await screen.findByLabelText("Name");
  expect(screen.queryByText(FIRST_USER)).not.toBeInTheDocument();
  expect(api.calls[0]?.url).toBe("/api/auth/sign-up-state?invite=tok_1");
  await fill(valid);
  await waitFor(() =>
    expect(auth.signUp.email).toHaveBeenCalledWith({ ...valid, invite: "tok_1" }),
  );
});

test("a missing invite shows the needs-an-invite line and a sign-in link, no form", async () => {
  serve({ bootstrap: false, invite: "missing" });
  renderApp("/sign-up", null);
  expect(await screen.findByText(MISSING)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
  expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign up" })).not.toBeInTheDocument();
});

test("an invalid invite shows the invalid line, no form", async () => {
  serve({ bootstrap: false, invite: "invalid" });
  renderApp("/sign-up?invite=bad", null);
  expect(await screen.findByText(INVALID)).toBeInTheDocument();
  expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
});

test("the gate's real 403 body (nested error) maps to the invalid line", async () => {
  serve({ bootstrap: false, invite: "valid" });
  auth.signUp.email.mockResolvedValue(
    gateError("invite_invalid", "This invite link isn't valid anymore."),
  );
  renderApp("/sign-up?invite=tok_1", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  expect(await screen.findByRole("alert")).toHaveTextContent(INVALID);
});

test("the gate's real 403 invite_required after loading as bootstrap shows the lost-race line", async () => {
  auth.signUp.email.mockResolvedValue(gateError("invite_required", "Sign-up needs an invite."));
  renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  expect(await screen.findByRole("alert")).toHaveTextContent(LOST_RACE);
});

test("the gate's real 403 invite_required on an invite page shows the needs-an-invite line", async () => {
  serve({ bootstrap: false, invite: "valid" });
  auth.signUp.email.mockResolvedValue(gateError("invite_required", "Sign-up needs an invite."));
  renderApp("/sign-up?invite=tok_1", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  expect(await screen.findByRole("alert")).toHaveTextContent(MISSING);
});

test("bootstrap with a stale invite link shows the form and the first-user line", async () => {
  serve({ bootstrap: true, invite: "invalid" });
  renderApp("/sign-up?invite=old", null);
  expect(await screen.findByLabelText("Name")).toBeInTheDocument();
  expect(screen.getByText(FIRST_USER)).toBeInTheDocument();
  expect(screen.queryByText(INVALID)).not.toBeInTheDocument();
});

const NAME_TOO_LONG = "Use 80 characters or fewer.";
const EMAIL_TOO_LONG = "Use 254 characters or fewer.";

test("a name over 80 or an email over 254 characters is refused under its field, without the server", async () => {
  const user = userEvent.setup();
  renderApp("/sign-up", null);
  const name = await screen.findByLabelText("Name");
  await user.click(name);
  await user.paste("n".repeat(81));
  await user.click(screen.getByLabelText("Email"));
  await user.paste(`${"a".repeat(255 - "@example.com".length)}@example.com`);
  await fill({ handle: valid.handle, password: valid.password });
  expect(name).toHaveAccessibleDescription(NAME_TOO_LONG);
  expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(EMAIL_TOO_LONG);
  expect(auth.signUp.email).not.toHaveBeenCalled();
});

test.each([
  ["NAME_TOO_LONG", "Name", NAME_TOO_LONG],
  ["EMAIL_TOO_LONG", "Email", EMAIL_TOO_LONG],
])("%s from the server is shown under %s", async (code, label, message) => {
  auth.signUp.email.mockResolvedValue({ data: null, error: { code, message, status: 400 } });
  renderApp("/sign-up", null);
  await screen.findByLabelText("Name");
  await fill(valid);
  await waitFor(() => expect(screen.getByLabelText(label)).toHaveAccessibleDescription(message));
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
});

test("an invalid handle shows the handle schema's first issue on blur", async () => {
  renderApp("/sign-up", null);
  const user = userEvent.setup();
  const handle = await screen.findByLabelText("Handle");
  await user.type(handle, "x");
  await user.tab();
  expect(handle).toHaveAccessibleDescription("Use 2 to 40 characters");
});
