import type { InviteItem, UserAdminItem } from "@open-factory/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Session } from "@/lib/session";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { type Handler, json, mockApi } from "@/test/mock-api";
import { renderApp } from "@/test/render-app";

vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

const NOW = new Date(2026, 10, 20, 10, 0);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const me: Session = {
  user: { id: "u-or", name: "Or Levi", handle: "or", email: "or@example.com", ref: "k3m5q7t9" },
};

const joined = new Date(2026, 10, 19, 9, 0).toISOString();
const user = (o: Partial<UserAdminItem> & { id: string; handle: string }): UserAdminItem => ({
  name: o.handle,
  email: `${o.handle}@example.com`,
  createdAt: joined,
  disabledAt: null,
  ...o,
});
const ME = user({ id: "u-or", handle: "or", name: "Or Levi" });
const ALICE = user({ id: "u-alice", handle: "alice", name: "Alice" });
const invite = (o: Partial<InviteItem> = {}): InviteItem => ({
  id: "inv-1",
  createdBy: "u-or",
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 6 * 86_400_000).toISOString(),
  ...o,
});

type World = { users?: UserAdminItem[]; invites?: InviteItem[]; extra?: Record<string, Handler> };
/** Lists are live arrays: mutation handlers change them, and the refetch sees it. */
function world(w: World = {}) {
  const state = { users: w.users ?? [ME, ALICE], invites: w.invites ?? [] };
  const api = mockApi({
    "GET /api/credentials": () => json({ credentials: [] }),
    "GET /api/secrets": () => json({ secrets: [] }),
    "GET /api/projects": () => json({ projects: [] }),
    "GET /api/usage/daily?": () => json({ timezone: "Europe/Berlin", days: [] }),
    "GET /api/usage/agents?": () => json({ agents: [] }),
    "GET /api/usage/credentials?": () =>
      json({
        credentials: [],
        unattributed: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          turns: 0,
        },
      }),
    "GET /api/users": () => json({ users: state.users }),
    "GET /api/invites": () => json({ invites: state.invites }),
    ...w.extra,
  });
  return { api, state };
}

const usersSection = () => screen.findByRole("region", { name: "Users" });
const userRow = async (handle: string) => {
  const region = await usersSection();
  await within(region).findByText(`@${handle}`);
  return within(region)
    .getAllByRole("listitem")
    .find((li) => li.getAttribute("data-name") === handle) as HTMLElement;
};
const openMenu = async (handle: string) => {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for @${handle}` }));
  return screen.findByRole("menu");
};

test("users list: name, handle, email, Joined day, (you), Disabled, and a labelled menu", async () => {
  world({
    users: [ME, ALICE, user({ id: "u-bob", handle: "bob", disabledAt: NOW.toISOString() })],
  });
  renderApp("/settings/users", me);
  const or = await userRow("or");
  expect(or).toHaveTextContent("Or Levi");
  expect(or).toHaveTextContent("(you)");
  expect(or).toHaveTextContent("or@example.com");
  expect(or).toHaveTextContent("Joined 19 Nov");
  const alice = await userRow("alice");
  expect(alice).not.toHaveTextContent("(you)");
  expect(alice).not.toHaveTextContent("Disabled");
  expect(await userRow("bob")).toHaveTextContent("Disabled");
  expect(screen.getByRole("button", { name: "Actions for @alice" })).toBeInTheDocument();
});

test("Disable is unavailable for the last enabled user, with the reason", async () => {
  // A stale list where you show as disabled: alice is then the only enabled user.
  world({ users: [{ ...ME, disabledAt: NOW.toISOString() }, ALICE] });
  renderApp("/settings/users", me);
  const menu = await openMenu("alice");
  expect(
    within(menu).getByRole("menuitem", { name: "Disable (last enabled user)" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    within(menu).getByRole("menuitem", { name: "Disable (last enabled user)" }),
  ).toHaveAttribute("data-variant", "destructive");
});

test("Disable is unavailable for yourself, with the reason", async () => {
  world();
  renderApp("/settings/users", me);
  const menu = await openMenu("or");
  expect(within(menu).getByRole("menuitem", { name: "Disable (that's you)" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test.each([
  [
    2,
    "They're signed out everywhere and can't sign in. Their 2 pending invites are revoked. You can enable them again later; revoked invites stay revoked.",
  ],
  [
    1,
    "They're signed out everywhere and can't sign in. Their pending invite is revoked. You can enable them again later; revoked invites stay revoked.",
  ],
  [
    0,
    "They're signed out everywhere and can't sign in. You can enable them again later; revoked invites stay revoked.",
  ],
])("Disable confirms with %i pending invites, then disables", async (n, body) => {
  const invites = Array.from({ length: n }, (_, i) =>
    invite({ id: `inv-${i}`, createdBy: "u-alice" }),
  );
  const { api, state } = world({
    users: [ME, { ...ALICE }],
    invites,
    extra: {
      "POST /api/users/u-alice/disable": () => {
        state.users = [ME, { ...ALICE, disabledAt: NOW.toISOString() }];
        state.invites = [];
        return json({ revokedInvites: n });
      },
    },
  });
  renderApp("/settings/users", me);
  if (n > 0) await screen.findAllByText(/Created by @alice/);
  const menu = await openMenu("alice");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Disable…" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("heading", { name: "Disable @alice?" })).toBeInTheDocument();
  expect(dialog).toHaveTextContent(body);
  await userEvent.click(within(dialog).getByRole("button", { name: "Disable @alice" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/users/u-alice/disable")).toBe(
    true,
  );
  await waitFor(async () => expect(await userRow("alice")).toHaveTextContent("Disabled"));
});

test.each([
  ["cannot_disable_self", "You can't disable yourself."],
  ["last_enabled_user", "@alice is the last enabled user. Enable someone else first."],
])("a 409 %s maps to its sentence", async (code, sentence) => {
  world({
    extra: {
      "POST /api/users/u-alice/disable": () =>
        json({ error: { code, message: "server text" } }, 409),
    },
  });
  renderApp("/settings/users", me);
  const menu = await openMenu("alice");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Disable…" }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Disable @alice" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(within(await userRow("alice")).getByRole("alert")).toHaveTextContent(sentence);
});

test("disabling a user who manages agents is refused, naming the agents to move", async () => {
  world({
    extra: {
      "POST /api/users/u-alice/disable": () =>
        json(
          {
            error: {
              code: "manages_agents",
              message: "server text",
              agents: ["ada", "cto", "dev"],
            },
          },
          409,
        ),
    },
  });
  renderApp("/settings/users", me);
  const menu = await openMenu("alice");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Disable…" }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Disable @alice" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  expect(within(await userRow("alice")).getByRole("alert")).toHaveTextContent(
    "@alice manages @ada, @cto and @dev. Move them to another manager first.",
  );
  expect(within(await userRow("alice")).queryByText("Disabled")).toBeNull();
});

test("Enable needs no confirmation and says so inline", async () => {
  const { state } = world({
    users: [ME, { ...ALICE, disabledAt: NOW.toISOString() }],
    extra: {
      "POST /api/users/u-alice/enable": () => {
        state.users = [ME, ALICE];
        return json(null, 204);
      },
    },
  });
  renderApp("/settings/users", me);
  const menu = await openMenu("alice");
  await userEvent.click(within(menu).getByRole("menuitem", { name: "Enable" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  const row = await userRow("alice");
  await waitFor(() =>
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Enabled @alice. They can sign in again.",
    ),
  );
  await waitFor(() => expect(row).not.toHaveTextContent("Disabled"));
});

test("a pending invite whose creator isn't listed reads Created by a former user", async () => {
  world({ invites: [invite({ createdBy: "u-gone" })] });
  renderApp("/settings/users", me);
  const region = await usersSection();
  expect(
    await within(region).findByText("Created by a former user · expires in 6 days"),
  ).toBeInTheDocument();
  expect(within(region).queryByText(/@unknown/)).toBeNull();
});

test("pending invites: creator and expiry; Revoke is immediate with Undo; Undo restores", async () => {
  const { api, state } = world({
    invites: [invite()],
    extra: {
      "POST /api/invites/inv-1/revoke": () => {
        state.invites = [];
        return json(null, 204);
      },
      "POST /api/invites/inv-1/restore": () => {
        state.invites = [invite()];
        return json(null, 204);
      },
    },
  });
  renderApp("/settings/users", me);
  const region = await usersSection();
  expect(
    await within(region).findByRole("heading", { level: 3, name: "Pending invites" }),
  ).toBeInTheDocument();
  expect(await within(region).findByText("Created by @or · expires in 6 days")).toBeInTheDocument();
  // Each Revoke names its invite, so a list of them reads apart.
  await userEvent.click(
    within(region).getByRole("button", { name: "Revoke the invite from @or, expires in 6 days" }),
  );
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(await within(region).findByText("Revoked the invite from @or.")).toBeInTheDocument();
  await waitFor(() =>
    expect(
      within(region).queryByText("Created by @or · expires in 6 days"),
    ).not.toBeInTheDocument(),
  );
  const undo = within(region).getByRole("button", { name: "Undo" });
  expect(undo).toHaveFocus();
  await userEvent.click(undo);
  expect(await within(region).findByText("Created by @or · expires in 6 days")).toBeInTheDocument();
  expect(within(region).queryByText("Revoked the invite from @or.")).not.toBeInTheDocument();
  expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual(
    expect.arrayContaining(["POST /api/invites/inv-1/revoke", "POST /api/invites/inv-1/restore"]),
  );
});

test("an Undo that fails says why", async () => {
  const { state } = world({
    invites: [invite()],
    extra: {
      "POST /api/invites/inv-1/revoke": () => {
        state.invites = [];
        return json(null, 204);
      },
      "POST /api/invites/inv-1/restore": () =>
        json({ error: { code: "invite_expired", message: "This invite has expired." } }, 409),
    },
  });
  renderApp("/settings/users", me);
  const region = await usersSection();
  await userEvent.click(await within(region).findByRole("button", { name: /^Revoke / }));
  await userEvent.click(await within(region).findByRole("button", { name: "Undo" }));
  const line = await within(region).findByText("Couldn't restore the invite: it has expired.");
  expect(line.closest("[role=alert]")).not.toBeNull();
});

test("Create invite link: the reveal is focused and selected, Copy, the shown-once line, Done; another replaces it", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  let n = 0;
  const { state } = world({
    extra: {
      "POST /api/invites": () => {
        n += 1;
        const inv = invite({ id: `inv-${n}` });
        state.invites = [...state.invites, inv];
        return json({ invite: inv, link: `http://f.test/sign-up?invite=tok${n}` }, 201);
      },
    },
  });
  renderApp("/settings/users", me);
  const region = await usersSection();
  await userEvent.click(await within(region).findByRole("button", { name: "Create invite link" }));
  const field = (await within(region).findByDisplayValue(
    "http://f.test/sign-up?invite=tok1",
  )) as HTMLInputElement;
  expect(field).toHaveAttribute("readonly");
  expect(field).toHaveFocus();
  expect(field.selectionStart).toBe(0);
  expect(field.selectionEnd).toBe(field.value.length);
  expect(region).toHaveTextContent(
    "Copy this link now. It isn't shown again. It works for one sign-up within 7 days.",
  );
  await userEvent.click(within(region).getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith("http://f.test/sign-up?invite=tok1");
  expect(await within(region).findByText("Copied.")).toBeInTheDocument();

  await userEvent.click(within(region).getByRole("button", { name: "Create invite link" }));
  expect(
    await within(region).findByDisplayValue("http://f.test/sign-up?invite=tok2"),
  ).toHaveFocus();
  expect(within(region).queryByDisplayValue("http://f.test/sign-up?invite=tok1")).toBeNull();
  expect(within(region).queryByText("Copied.")).toBeNull();

  await userEvent.click(within(region).getByRole("button", { name: "Done" }));
  expect(within(region).queryByDisplayValue(/sign-up\?invite=/)).toBeNull();
  expect(within(region).getByRole("button", { name: "Create invite link" })).toHaveFocus();
});

test("a failed create says so", async () => {
  world({
    extra: {
      "POST /api/invites": () => json({ error: { code: "internal", message: "boom" } }, 500),
    },
  });
  renderApp("/settings/users", me);
  const region = await usersSection();
  await userEvent.click(await within(region).findByRole("button", { name: "Create invite link" }));
  expect(
    await within(region).findByText("Couldn't create an invite. Try again."),
  ).toBeInTheDocument();
});

test("a failed users load shows its line with Retry", async () => {
  world({
    extra: { "GET /api/users": () => json({ error: { code: "internal", message: "x" } }, 500) },
  });
  renderApp("/settings/users", me);
  const region = await usersSection();
  expect(await within(region).findByText("Couldn't load users.")).toBeInTheDocument();
  expect(within(region).getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

test("phone: a user's menu is a drawer titled with their handle", async () => {
  const original = window.matchMedia;
  fakeMatchMedia.install(true, { coarse: true });
  try {
    world({ users: [ME, ALICE] });
    renderApp("/settings/users", me);
    const trigger = await screen.findByRole("button", { name: "Actions for @alice" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "touch" });
    fireEvent.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "@alice" });
    expect(within(drawer).getByRole("button", { name: "Disable…" })).toBeInTheDocument();
  } finally {
    window.matchMedia = original;
  }
});
