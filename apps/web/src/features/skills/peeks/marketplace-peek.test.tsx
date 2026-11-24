import type { ServerMessage } from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, marketplaceRow, plugin } from "../fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (_o: { onMessage?: (m: ServerMessage) => void }) => ({
    close() {},
    status: () => "open",
    send: () => true,
  }),
}));
vi.mock("@/components/ui/toaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toaster")>();
  return { ...actual, notify: vi.fn(actual.notify) };
});

beforeEach(() => fakeMatchMedia.install(false));
afterEach(() => vi.clearAllMocks());

const OLD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NEW = "e4f5a6b1111111111111111111111111111111aa";
const UNREAD = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const updateView = {
  from: OLD,
  to: NEW,
  committedAt: "2026-11-21T10:00:00Z",
  subject: "Add a guard hook",
  changed: [
    { name: "docs", what: ["version"], runsCodeChanged: false },
    { name: "review", what: ["tree"], runsCodeChanged: true },
  ],
  removed: ["old"],
  added: ["fresh"],
};

/** A registry row as `GET /api/library/marketplaces/:name` returns it (the list row's fields, no plugins or users). */
const view = (o: Record<string, unknown> = {}) => {
  const { plugins: _p, users: _u, ...row } = marketplaceRow("acme");
  return { ...row, update: null, ...o };
};

type Routes = Parameters<typeof mockApi>[0];
async function open(
  rows = [marketplaceRow("acme", { plugins: [plugin("review@acme", { version: "1.0.0" })] })],
  routes: Routes = {},
) {
  const mocks = mockApi({
    "GET /api/library/marketplaces": () => json({ marketplaces: rows }),
    "GET /api/library/marketplaces/acme": () => json(view()),
    "GET /api/library/skills": () => json(library([hostGroup()])),
    "GET /api/library/plugins": () => json({ marketplaces: [], host: [] }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
    ...routes,
  });
  const user = userEvent.setup();
  renderApp("/skills/marketplaces", alice);
  await user.click(await screen.findByRole("button", { name: /acme/ }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("heading", { level: 3, name: "Source" });
  return { mocks, user, dialog: within(dialog) };
}

test("Check for updates reports Up to date. when nothing is newer", async () => {
  const {
    user,
    dialog: d,
    mocks,
  } = await open(undefined, {
    "POST /api/library/marketplaces/acme/check": () => json(view()),
  });
  await user.click(d.getByRole("button", { name: "Check for updates" }));
  expect(await d.findByText("Up to date.")).toBeInTheDocument();
  expect(mocks.calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([
    "/api/library/marketplaces/acme/check",
  ]);
});

test("a local folder marketplace is Live and has no Check for updates", async () => {
  const folder = {
    source: { source: "directory" as const, path: "/srv/mkt" },
    commit: null,
    branch: null,
  };
  const { dialog: d } = await open([marketplaceRow("acme", folder)], {
    "GET /api/library/marketplaces/acme": () => json(view(folder)),
  });
  expect(d.getByText("Live")).toBeInTheDocument();
  expect(d.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
});

test("the update view lists changed plugins with Runs code changed first, and Update moves the Library's commit", async () => {
  let updated = false;
  const {
    user,
    dialog: d,
    mocks,
  } = await open([marketplaceRow("acme", { updateCommit: NEW })], {
    "GET /api/library/marketplaces/acme": () =>
      json(updated ? view({ commit: NEW }) : view({ updateCommit: NEW, update: updateView })),
    "POST /api/library/marketplaces/acme/update": () => {
      updated = true;
      return json(view({ commit: NEW }));
    },
  });
  const changed = (await d.findByText("Runs code changed")).closest("li") as HTMLElement;
  expect(changed).toHaveTextContent("review");
  const order = d
    .getAllByRole("listitem")
    .map((li) => li.textContent)
    .filter((t) => /^(review|docs)/.test(t ?? ""));
  expect(order[0]).toMatch(/^review/);
  expect(order[1]).toMatch(/^docs/);
  expect(
    d.getByText("Templates keep their pins. Move a pin in the template's Configuration."),
  ).toBeInTheDocument();
  await user.click(d.getByRole("button", { name: "Update Skills to e4f5a6b" }));
  expect(await d.findByText("Updated to e4f5a6b.")).toBeInTheDocument();
  expect(mocks.calls.find((c) => c.url.endsWith("/acme/update"))?.body).toEqual({ commit: NEW });
});

test("Pinned by templates marks an older pin and shows Latest with its badge", async () => {
  const users = (name: string, pin: string) => ({ name, pin, agents: 1 });
  const { dialog: d } = await open(
    [
      marketplaceRow("acme", {
        plugins: [
          plugin("a@acme", {
            usedBy: {
              templates: [users("dev", `commit:${OLD}`), users("old", `commit:${UNREAD}`)],
              overlays: [],
            },
          }),
          plugin("b@acme", { usedBy: { templates: [users("ops", "latest")], overlays: [] } }),
        ],
        usedBy: { templates: 3, agents: 3 },
      }),
    ],
    {
      "GET /api/library/marketplaces/acme": () =>
        json(view({ usedBy: { templates: 3, agents: 3 } })),
      "GET /api/library/plugins/a%40acme?": () =>
        json({ error: { code: "not_read", message: "Not found" } }, 404),
    },
  );
  const pinned = (await d.findByRole("heading", { name: "Pinned by templates" })).closest(
    "section",
  ) as HTMLElement;
  const p = within(pinned);
  expect(p.getByRole("link", { name: "dev" }).closest("li")).not.toHaveTextContent("older");
  expect(p.getByRole("link", { name: "old" }).closest("li")).toHaveTextContent("older");
  expect(p.getByText("auto-updates")).toBeInTheDocument();
});

test("a pin Skills hasn't read has a Fetch that reads it", async () => {
  let read = false;
  const rows = [
    marketplaceRow("acme", {
      plugins: [
        plugin("a@acme", {
          usedBy: {
            templates: [{ name: "old", pin: `commit:${UNREAD}`, agents: 1 }],
            overlays: [],
          },
        }),
      ],
      usedBy: { templates: 1, agents: 1 },
    }),
  ];
  const {
    user,
    dialog: d,
    mocks,
  } = await open(rows, {
    "GET /api/library/plugins/a%40acme?": () =>
      read
        ? json({
            key: "a@acme",
            name: "a",
            marketplace: "acme",
            from: "library",
            commit: UNREAD,
            version: null,
            description: null,
            pinnable: true,
            state: "ok",
            source: { kind: "relative", detail: "./a" },
            contents: null,
            contentsNote: "Contents not read yet",
            canRead: false,
            hostVersion: null,
            usedBy: { templates: [], overlays: [] },
          })
        : json({ error: { code: "not_read", message: "Not found" } }, 404),
    "POST /api/library/marketplaces/acme/fetch": () => {
      read = true;
      return json({ sha: UNREAD });
    },
  });
  expect(await d.findByText("Skills hasn't read acme at 9f8e7d6.")).toBeInTheDocument();
  await user.click(d.getByRole("button", { name: "Fetch" }));
  expect(await d.findByText("Read acme at 9f8e7d6.")).toBeInTheDocument();
  await waitFor(() =>
    expect(d.queryByText("Skills hasn't read acme at 9f8e7d6.")).not.toBeInTheDocument(),
  );
  expect(mocks.calls.find((c) => c.url.endsWith("/acme/fetch"))?.body).toEqual({ ref: UNREAD });
});

test("a hand-written tag pin Skills hasn't read has a Fetch that sends the tag whole", async () => {
  const rows = [
    marketplaceRow("acme", {
      plugins: [
        plugin("a@acme", {
          usedBy: { templates: [{ name: "old", pin: "tag:v2.0.0-beta", agents: 1 }], overlays: [] },
        }),
      ],
      usedBy: { templates: 1, agents: 1 },
    }),
  ];
  const {
    user,
    dialog: d,
    mocks,
  } = await open(rows, {
    "GET /api/library/plugins/a%40acme?": () =>
      json({ error: { code: "not_read", message: "Not found" } }, 404),
    "POST /api/library/marketplaces/acme/fetch": () => json({ sha: UNREAD }),
  });
  expect(await d.findByText("Skills hasn't read acme at v2.0.0-beta.")).toBeInTheDocument();
  await user.click(d.getByRole("button", { name: "Fetch" }));
  expect(await d.findByText("Read acme at v2.0.0-beta.")).toBeInTheDocument();
  expect(mocks.calls.find((c) => c.url.endsWith("/acme/fetch"))?.body).toEqual({
    ref: "v2.0.0-beta",
  });
  expect(mocks.calls.some((c) => c.url.includes("commit=v2.0.0-beta"))).toBe(true);
});

test("a plugin opens in place with Back, Back returns focus to its row, and Esc closes the whole peek", async () => {
  const { user, dialog: d } = await open(undefined, {
    "GET /api/library/plugins/review%40acme": () =>
      json({
        key: "review@acme",
        name: "review",
        marketplace: "acme",
        from: "library",
        commit: OLD,
        version: "1.0.0",
        description: "Reviews",
        pinnable: true,
        state: "ok",
        source: { kind: "relative", detail: "./review" },
        contents: null,
        contentsNote: "Contents not read yet",
        canRead: false,
        hostVersion: null,
        usedBy: { templates: [], overlays: [] },
      }),
  });
  const row = d.getByRole("button", { name: "review" });
  await user.click(row);
  expect(await screen.findByText("Contents not read yet", { selector: "p" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("heading", { level: 3, name: "Source" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "review" })).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

test("a marketplace that templates use can't be removed, and says why", async () => {
  const {
    user,
    dialog: d,
    mocks,
  } = await open([marketplaceRow("acme", { usedBy: { templates: 2, agents: 0 } })], {
    "GET /api/library/marketplaces/acme": () => json(view({ usedBy: { templates: 2, agents: 0 } })),
  });
  const reason = await d.findByText("Templates use plugins from acme. Remove them first.");
  const remove = d.getByRole("button", { name: /Remove marketplace/ });
  expect(remove).toHaveAttribute("aria-disabled", "true");
  expect(remove).toHaveAccessibleDescription(reason.textContent ?? "");
  await user.click(remove);
  expect(mocks.calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("removing an unused marketplace closes the peek with an Undo toast, and Undo restores it", async () => {
  const {
    user,
    dialog: d,
    mocks,
  } = await open(undefined, {
    "DELETE /api/library/marketplaces/acme": () =>
      json({ undoUntil: new Date(Date.now() + 30_000).toISOString() }),
    "POST /api/library/marketplaces/acme/restore": () => json(view()),
  });
  await user.click(await d.findByRole("button", { name: /Remove marketplace/ }));
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: "Removed acme." })),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await vi.mocked(notify).mock.calls.at(-1)?.[0].undo?.();
  expect(mocks.calls.some((c) => c.method === "POST" && c.url.endsWith("/acme/restore"))).toBe(
    true,
  );
});
