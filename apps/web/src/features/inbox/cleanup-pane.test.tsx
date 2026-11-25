import type { Cleanup, ServerMessage } from "@open-factory/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onOpen?: () => void }) => {
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: (_: ServerMessage) => true };
  },
}));

const originalMatchMedia = window.matchMedia;
const LONG = `feat/${"very-long-branch-name-".repeat(8)}end`;
const FOOTER = "Push them to keep the work, or delete them in the project's repository.";

const item = (cleanup: Cleanup) => ({
  id: "c1",
  messageId: "m-c1",
  kind: "notice",
  read: true,
  from: { kind: "factory", name: "factory" },
  about: "dev-ab12",
  to: "everyone",
  preview: "Cleaned up @dev-ab12's worktrees.",
  urgent: false,
  createdAt: new Date(2026, 10, 25, 13, 50).toISOString(),
  notice: "worktrees_kept",
  cleanup,
  link: { kind: "session", agentSlug: "dev-ab12" },
});

let writeText: ReturnType<typeof vi.fn>;
async function open(cleanup: Cleanup) {
  mockApi({
    "GET /api/inbox?": () => json({ chats: [], items: [item(cleanup)], nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: 0, byAgent: {} }),
  });
  fakeMatchMedia.installWidth(1280);
  renderApp("/inbox?item=c1", alice);
  const pane = await screen.findByRole("region", { name: "Reading pane" });
  await within(pane).findByText(/@dev-ab12's worktrees\./);
  return pane;
}

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.unstubAllGlobals();
});

test("groups the result by project, with the footer when something was kept", async () => {
  const pane = await open({
    projects: [
      {
        project: "web",
        removed: true,
        deleted: ["feat/y"],
        kept: [
          { branch: "feat/x", commits: 3 },
          { branch: "feat/z", reason: "elsewhere" },
        ],
      },
      {
        project: "docs",
        removed: false,
        deleted: [],
        kept: [],
        error: "couldn't clean up: EACCES",
      },
    ],
  });
  expect(
    within(pane).getByText("Couldn't fully clean up @dev-ab12's worktrees."),
  ).toBeInTheDocument();
  expect(within(pane).getByRole("heading", { name: "web" })).toBeInTheDocument();
  expect(within(pane).getByRole("heading", { name: "docs" })).toBeInTheDocument();
  expect(within(pane).getByText("Removed the worktrees.")).toBeInTheDocument();
  expect(within(pane).getByText("feat/y")).toBeInTheDocument();
  expect(within(pane).getByText("(3 commits not pushed or merged)")).toBeInTheDocument();
  expect(within(pane).getByText("(checked out elsewhere)")).toBeInTheDocument();
  expect(within(pane).getByText("couldn't clean up: EACCES")).toBeInTheDocument();
  expect(within(pane).getByText(FOOTER)).toBeInTheDocument();
});

test("no footer when nothing was kept", async () => {
  const pane = await open({
    projects: [{ project: "web", removed: true, deleted: ["feat/y"], kept: [] }],
  });
  expect(within(pane).queryByText(FOOTER)).toBeNull();
});

test("a host problem with no projects reads as the host line, once, with no footer", async () => {
  const pane = await open({ projects: [], host: "too_old" });
  expect(
    within(pane).getByText("Couldn't fully clean up @dev-ab12's worktrees."),
  ).toBeInTheDocument();
  expect(
    within(pane).getByText(
      "Couldn't clean up worktrees: git 2.44 or newer is needed on the factory host.",
    ),
  ).toBeInTheDocument();
  expect(within(pane).queryByText(FOOTER)).toBeNull();
});

test("copying a branch writes its name and shows the shared feedback", async () => {
  const pane = await open({
    projects: [
      { project: "web", removed: true, deleted: [], kept: [{ branch: LONG, commits: 2 }] },
    ],
  });
  expect(within(pane).getByText(LONG)).toBeInTheDocument();
  await userEvent.click(within(pane).getByRole("button", { name: `Copy ${LONG}` }));
  expect(writeText).toHaveBeenCalledWith(LONG);
  expect(await within(pane).findByRole("button", { name: `Copied ${LONG}` })).toBeInTheDocument();
});

test("a refused clipboard says Couldn't copy inline", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  const pane = await open({
    projects: [
      { project: "web", removed: true, deleted: [], kept: [{ branch: "feat/x", commits: 1 }] },
    ],
  });
  await userEvent.click(within(pane).getByRole("button", { name: "Copy feat/x" }));
  expect(await within(pane).findByText("Couldn't copy")).toBeInTheDocument();
});

test("no composer, and the header opens the agent's session", async () => {
  const pane = await open({
    projects: [
      { project: "web", removed: true, deleted: [], kept: [{ branch: "feat/x", commits: 1 }] },
    ],
  });
  expect(within(pane).queryByRole("textbox")).toBeNull();
  expect(within(pane).getByRole("link", { name: "Open in session" })).toHaveAttribute(
    "href",
    "/agents/dev-ab12/session",
  );
});
