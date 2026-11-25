import type { ServerMessage } from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, marketplaceRow, plugin } from "./fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (_o: { onMessage?: (m: ServerMessage) => void }) => ({
    close() {},
    status: () => "open",
    send: () => true,
  }),
}));

beforeEach(() => fakeMatchMedia.install(false));

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

async function open(rows: ReturnType<typeof marketplaceRow>[]) {
  mockApi({
    "GET /api/library/marketplaces": () => json({ marketplaces: rows }),
    "GET /api/library/marketplaces/acme": () => json({ error: { code: "x", message: "x" } }, 500),
    "GET /api/library/marketplaces/beta": () => json({ error: { code: "x", message: "x" } }, 500),
    "GET /api/library/skills": () => json(library([hostGroup()])),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
  });
  const user = userEvent.setup();
  renderApp("/skills/marketplaces", alice);
  await screen.findByRole("heading", { level: 1, name: "Skills" });
  return user;
}

const row = (name: RegExp) => screen.findByRole("button", { name });
const many = (n: number) => Array.from({ length: n }, (_, i) => plugin(`p${i}@acme`));

test("a row shows the name, source, commit, plugin count and who uses it", async () => {
  await open([
    marketplaceRow("acme", {
      source: { source: "github", repo: "org/repo" },
      plugins: many(12),
      usedBy: { templates: 3, agents: 40 },
    }),
  ]);
  const r = await row(/^acme/);
  expect(r).toHaveTextContent("org/repo");
  expect(within(r).getByText(COMMIT.slice(0, 7))).toBeInTheDocument();
  expect(within(r).getByText("12 plugins")).toBeInTheDocument();
  expect(within(r).getByText("Used by 3 templates")).toBeInTheDocument();
});

test("a git URL shows its host and path, and a folder shows Live with its path", async () => {
  await open([
    marketplaceRow("gitm", {
      source: { source: "git", url: "https://git.example.com/team/mkt.git" },
    }),
    marketplaceRow("dirm", {
      source: { source: "directory", path: "/srv/mkt" },
      commit: null,
      branch: null,
    }),
  ]);
  expect(await row(/^gitm/)).toHaveTextContent("git.example.com/team/mkt");
  const dir = await row(/^dirm/);
  expect(dir).toHaveTextContent("/srv/mkt");
  expect(within(dir).getByText("Live")).toBeInTheDocument();
});

test("a marketplace with nothing using it says Not used, and one plugin is singular", async () => {
  await open([marketplaceRow("acme", { plugins: many(1) })]);
  const r = await row(/^acme/);
  expect(within(r).getByText("Not used")).toBeInTheDocument();
  expect(within(r).getByText("1 plugin")).toBeInTheDocument();
});

test.each([
  ["Checking…", { checking: { since: "2026-11-24T10:00:00.000Z" } }],
  ["Couldn't check", { checkError: "Couldn't reach the remote." }],
  ["Update available", { updateCommit: "e4f5a6b1111111111111111111111111111111aa" }],
  ["Adding…", { state: "adding" as const, since: "2026-11-24T10:00:00.000Z" }],
])("a marketplace that is %s shows that one state", async (word, o) => {
  await open([marketplaceRow("acme", o)]);
  expect(within(await row(/^acme/)).getByText(word)).toBeInTheDocument();
});

test("when it is checking and has an update, Checking wins", async () => {
  await open([
    marketplaceRow("acme", {
      checking: { since: "2026-11-24T10:00:00.000Z" },
      updateCommit: "e4f5a6b1111111111111111111111111111111aa",
    }),
  ]);
  const r = await row(/^acme/);
  expect(within(r).getByText("Checking…")).toBeInTheDocument();
  expect(within(r).queryByText("Update available")).not.toBeInTheDocument();
});

test("an empty registry says so", async () => {
  await open([]);
  expect(
    await screen.findByText("No marketplaces yet. Add one to pick plugins."),
  ).toBeInTheDocument();
});

test("j and k move between rows, Space opens a peek and closes it on the shown row", async () => {
  const user = await open([marketplaceRow("acme"), marketplaceRow("beta")]);
  const acme = await row(/^acme/);
  acme.focus();
  await user.keyboard("j");
  const beta = screen.getByRole("button", { name: /^beta/ });
  expect(beta).toHaveFocus();
  await user.keyboard(" ");
  expect(beta).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("k");
  expect(acme).toHaveFocus();
  expect(acme).toHaveAttribute("aria-expanded", "true");
  expect(beta).toHaveAttribute("aria-expanded", "false");
  await user.keyboard(" ");
  await waitFor(() => expect(acme).toHaveAttribute("aria-expanded", "false"));
});
