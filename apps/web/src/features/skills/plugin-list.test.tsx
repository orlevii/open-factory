import type { ServerMessage } from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { closeSheet } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, NO_CONTENTS, plugin, pluginGroup, pluginsResponse } from "./fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (_o: { onMessage?: (m: ServerMessage) => void }) => ({
    close() {},
    status: () => "open",
    send: () => true,
  }),
}));

beforeEach(() => fakeMatchMedia.install(false));
afterEach(() => closeSheet());

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function serve(data: unknown, extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    "GET /api/library/plugins": () => json(data),
    "GET /api/library/skills": () => json(library([hostGroup()])),
    "GET /api/library/marketplaces": () => json({ marketplaces: [] }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
    ...extra,
  });
}

async function open(data: unknown, extra: Parameters<typeof mockApi>[0] = {}) {
  serve(data, extra);
  const user = userEvent.setup();
  renderApp("/skills/plugins", alice);
  await screen.findByRole("heading", { level: 1, name: "Skills" });
  return user;
}

const row = (name: RegExp | string) => screen.findByRole("button", { name });

test("one group per marketplace is headed with its commit or Local folder, live, then On this host", async () => {
  await open(
    pluginsResponse(
      [
        pluginGroup("acme", COMMIT, [plugin("review@acme")]),
        pluginGroup("mine", null, [plugin("tool@mine")]),
      ],
      [
        {
          key: "extra@elsewhere",
          name: "extra",
          marketplace: "elsewhere",
          version: "1.2.0",
          lastUpdated: null,
          contentsSummary: { ...NO_CONTENTS, skills: 1 },
        },
      ],
    ),
  );
  const acme = await screen.findByRole("list", { name: "acme" });
  expect(within(acme).getByRole("button", { name: /review/ })).toBeInTheDocument();
  expect(screen.getByText("a1b2c3d")).toBeInTheDocument();
  const mine = screen.getByRole("list", { name: "mine" });
  expect(within(mine).getByRole("button", { name: /tool/ })).toBeInTheDocument();
  expect(screen.getByText("Local folder, live")).toBeInTheDocument();
  const host = screen.getByRole("list", { name: "On this host" });
  expect(within(host).getByRole("button", { name: /extra/ })).toBeInTheDocument();
});

test("a row's contents line shows the first three kinds, then +N more, with Parts not shown first", async () => {
  await open(
    pluginsResponse([
      pluginGroup("acme", COMMIT, [
        plugin("big@acme", {
          contentsSummary: {
            ...NO_CONTENTS,
            hooks: 2,
            mcp: 1,
            skills: 3,
            commands: 4,
            agents: 1,
            unshown: 1,
          },
        }),
      ]),
    ]),
  );
  const r = await row(/big/);
  const items = within(r)
    .getAllByRole("listitem")
    .map((i) => i.textContent?.replace(/\u00a0/g, " "));
  expect(items).toEqual(["Parts not shown", "2 hooks", "1 MCP server", "3 skills", "+2 more"]);
});

test("a plugin with nothing to show says so", async () => {
  await open(
    pluginsResponse([
      pluginGroup("acme", COMMIT, [plugin("bare@acme", { contentsSummary: NO_CONTENTS })]),
    ]),
  );
  expect(within(await row(/bare/)).getByText("Nothing to show")).toBeInTheDocument();
});

test("a hex version shows as the commit it is, and a semver stays as it is", async () => {
  await open(
    pluginsResponse([
      pluginGroup("acme", COMMIT, [
        plugin("a@acme", { version: "0120fb8a1b2c3d4e" }),
        plugin("b@acme", { version: "1.4.2" }),
      ]),
    ]),
  );
  expect(within(await row(/^a/)).getByText("commit 0120fb8")).toBeInTheDocument();
  expect(within(await row(/^b/)).getByText("1.4.2")).toBeInTheDocument();
});

test("the Latest badge appears only on a plugin a template uses at Latest", async () => {
  const user = (name: string, pin: string) => ({ name, pin, agents: 3 });
  await open(
    pluginsResponse([
      pluginGroup("acme", COMMIT, [
        plugin("fast@acme", {
          usedBy: {
            templates: [
              user("dev", "latest"),
              user("ops", "latest"),
              user("qa", `commit:${COMMIT}`),
            ],
            overlays: [],
          },
        }),
        plugin("slow@acme", {
          usedBy: { templates: [user("dev", `commit:${COMMIT}`)], overlays: [] },
        }),
      ]),
    ]),
  );
  const fast = await row(/^fast/);
  expect(within(fast).getByText("auto-updates")).toBeInTheDocument();
  expect(within(fast).getByText("2 use Latest")).toBeInTheDocument();
  expect(within(fast).getByText("Used by 3 templates · 9 agents")).toBeInTheDocument();
  expect(within(await row(/^slow/)).queryByText(/auto-updates/)).not.toBeInTheDocument();
});

test.each([
  ["a refused source", { state: "refused" as const, pinnable: false }, "Can't use"],
  [
    "a plugin that follows its own source",
    { state: "cant_pin" as const, pinnable: false },
    "Can't be pinned",
  ],
  ["a plugin that is not pinnable but otherwise fine", { pinnable: false }, "Can't be pinned"],
  [
    "a missing folder, even when it can't be pinned",
    { state: "missing" as const, pinnable: false },
    "Missing",
  ],
])("%s shows %s as its one state", async (_name, entry, word) => {
  await open(pluginsResponse([pluginGroup("acme", COMMIT, [plugin("x@acme", entry)])]));
  const r = await row(/^x/);
  expect(within(r).getByText(word)).toBeInTheDocument();
  expect(within(r).queryAllByText(/Can't|Missing/)).toHaveLength(1);
});

test("an empty view says so and its link opens Add marketplace on the Marketplaces view", async () => {
  const user = await open(pluginsResponse([]), {
    "GET /api/library/marketplaces": () => json({ marketplaces: [] }),
  });
  expect(
    await screen.findByText(/No plugins yet\. Add a marketplace to pick plugins\./),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Add a marketplace" }));
  expect(await screen.findByRole("dialog", { name: "Add marketplace" })).toBeInTheDocument();
  expect(
    await screen.findByText("No marketplaces yet. Add one to pick plugins."),
  ).toBeInTheDocument();
});

test("a failed load shows the error line, and Retry loads the list", async () => {
  let ok = false;
  const user = await open(null, {
    "GET /api/library/plugins": () =>
      ok
        ? json(pluginsResponse([pluginGroup("acme", COMMIT, [plugin("late@acme")])]))
        : json({ error: { code: "boom", message: "boom" } }, 500),
  });
  expect(await screen.findByText("Couldn't load plugins.")).toBeInTheDocument();
  ok = true;
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await row(/late/)).toBeInTheDocument();
});

test("j and k move between plugin rows, Space opens a peek and closes it on the shown row", async () => {
  const user = await open(
    pluginsResponse([pluginGroup("acme", COMMIT, [plugin("one@acme"), plugin("two@acme")])]),
    {
      "GET /api/library/plugins/one%40acme": () =>
        json({ error: { code: "x", message: "x" } }, 500),
      "GET /api/library/plugins/two%40acme": () =>
        json({ error: { code: "x", message: "x" } }, 500),
    },
  );
  const one = await row(/^one/);
  one.focus();
  await user.keyboard("j");
  const two = screen.getByRole("button", { name: /^two/ });
  expect(two).toHaveFocus();
  await user.keyboard(" ");
  expect(two).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("k");
  expect(one).toHaveFocus();
  expect(one).toHaveAttribute("aria-expanded", "true");
  expect(two).toHaveAttribute("aria-expanded", "false");
  await user.keyboard(" ");
  await waitFor(() => expect(one).toHaveAttribute("aria-expanded", "false"));
});
