import type { ServerMessage } from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, skill, source, sourceGroup } from "../fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (_o: { onMessage?: (m: ServerMessage) => void }) => ({
    close() {},
    status: () => "open",
    send: () => true,
  }),
}));

beforeEach(() => fakeMatchMedia.install(false));

const PIN = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

const detail = (group: string, name: string, o: Record<string, unknown> = {}) => ({
  name,
  description: `${name} description`,
  state: "ok",
  usedBy: { templates: 0, agents: 0 },
  group,
  hooks: [],
  usedByTemplates: [],
  files: [{ path: "SKILL.md", executable: false }],
  skillMd: "# review\nfirst line",
  ...o,
});

const sourceDetail = {
  id: "s1",
  kind: "github",
  path: null,
  repo: "acme/s1",
  subpath: null,
  branch: "main",
  pin: PIN,
  committedAt: null,
  subject: null,
  state: "ready",
  skills: ["review"],
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  usedBy: { templates: 0, agents: 0 },
  update: null,
};

async function open(
  skillDetail: Record<string, unknown>,
  extra: Parameters<typeof mockApi>[0] = {},
) {
  const mocks = mockApi({
    "GET /api/library/skills": () =>
      json(library([hostGroup(), sourceGroup(source("s1", { pin: PIN }), [skill("review")])])),
    "GET /api/library/skills/source%3As1/review": () => json(skillDetail),
    "GET /api/library/sources/s1": () => json(sourceDetail),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
    ...extra,
  });
  const user = userEvent.setup();
  renderApp("/skills", alice);
  await user.click(await screen.findByRole("button", { name: /^review/ }));
  await screen.findByRole("heading", { name: "review" });
  return { mocks, user };
}

const base = detail("source:s1", "review");

test("the From line links to the Source peek, and Back returns to the skill", async () => {
  const { user } = await open(base);
  await user.click(await screen.findByRole("button", { name: /^From acme\/s1 · a1b2c3d$/ }));
  expect(await screen.findByRole("heading", { level: 3, name: "Source" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("heading", { name: "review" })).toBeInTheDocument();
});

test("coming from the Source peek, the From line is plain text and Back refocuses the skill it came from", async () => {
  const { user } = await open(base);
  await user.click(await screen.findByRole("button", { name: /^From acme\/s1/ }));
  const inSource = await screen.findByRole("button", { name: "review" });
  await user.click(inSource);
  await screen.findByRole("button", { name: "Back" });
  expect(screen.queryByRole("button", { name: /^From acme\/s1/ })).not.toBeInTheDocument();
  expect(screen.getByText(/^From acme\/s1 · a1b2c3d$/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back" }));
  const again = await screen.findByRole("button", { name: "review" });
  await waitFor(() => expect(again).toHaveFocus());
});

test("Esc closes the whole peek, not just one level", async () => {
  const { user } = await open(base);
  await user.click(await screen.findByRole("button", { name: /^From acme\/s1/ }));
  await user.click(await screen.findByRole("button", { name: "review" }));
  await screen.findByRole("button", { name: "Back" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

test("Runs code lists the frontmatter hooks, before Used by and Files", async () => {
  await open(
    detail("source:s1", "review", {
      hooks: [{ event: "PreToolUse", matcher: "Bash", command: "./guard.sh --strict" }],
      usedByTemplates: [{ name: "dev", agents: 190 }],
    }),
  );
  const runs = await screen.findByRole("heading", { level: 3, name: "Runs code" });
  expect(screen.getByText("./guard.sh --strict")).toBeInTheDocument();
  const order = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
  expect(order).toEqual(["Runs code", "Used by", "Files"]);
  expect(runs).toBeInTheDocument();
});

test("a hook command with a bidi override shows it as a visible token", async () => {
  await open(
    detail("source:s1", "review", {
      hooks: [{ event: "Stop", matcher: "", command: "echo ‮txt.sh" }],
    }),
  );
  expect(await screen.findByText(/echo ⟨U\+202E⟩txt\.sh/)).toBeInTheDocument();
});

test("Used by is grouped by template and collapses past 8 behind Show all", async () => {
  const { user } = await open(
    detail("source:s1", "review", {
      usedByTemplates: Array.from({ length: 10 }, (_, i) => ({ name: `t${i + 1}`, agents: i + 1 })),
    }),
  );
  const section = (await screen.findByRole("heading", { level: 3, name: "Used by" })).closest(
    "section",
  );
  const scope = within(section as HTMLElement);
  expect(scope.getByRole("link", { name: "t1" })).toHaveAttribute("href", "/templates/t1");
  expect(scope.getAllByRole("listitem")).toHaveLength(9);
  expect(scope.queryByRole("link", { name: "t9" })).not.toBeInTheDocument();
  await user.click(scope.getByRole("button", { name: "Show all 10" }));
  expect(scope.getByRole("link", { name: "t10" })).toBeInTheDocument();
});

test("the Files list collapses past 20, and executables say they run code", async () => {
  const files = Array.from({ length: 25 }, (_, i) => ({
    path: i === 0 ? "SKILL.md" : `f${i}.txt`,
    executable: i === 3,
  }));
  const { user } = await open(detail("source:s1", "review", { files }));
  const section = (await screen.findByRole("heading", { level: 3, name: "Files" })).closest(
    "section",
  );
  const scope = within(section as HTMLElement);
  expect(scope.getAllByRole("button", { name: /View file/ })).toHaveLength(20);
  expect(scope.getByText("Runs code")).toBeInTheDocument();
  await user.click(scope.getByRole("button", { name: "Show all 25" }));
  expect(scope.getAllByRole("button", { name: /View file/ })).toHaveLength(25);
});

test("View file is one toggle that opens from line 1, and only then fetches", async () => {
  const { mocks, user } = await open(
    detail("source:s1", "review", {
      files: [
        { path: "SKILL.md", executable: false },
        { path: "notes.txt", executable: false },
      ],
    }),
    {
      "GET /api/library/skills/source%3As1/review/file?": () =>
        json({ path: "notes.txt", text: lines(100) }),
    },
  );
  const toggles = await screen.findAllByRole("button", { name: "View file" });
  const toggle = toggles[1] as HTMLElement;
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(mocks.calls.some((c) => c.url.includes("/file"))).toBe(false);
  await user.click(toggle);
  expect(toggle).toHaveAccessibleName("Hide file");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle).toHaveFocus();
  const text = await screen.findByText(/^line 1 line 2/);
  expect(text.textContent?.startsWith("line 1\nline 2")).toBe(true);
  expect(screen.queryByText(/line 41/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Show all · 100 lines" })).toBeInTheDocument();
  expect(mocks.calls.find((c) => c.url.includes("/file"))?.url).toContain("path=notes.txt");
});

test("a file's text is fetched once for a pinned source: closing and reopening reuses it", async () => {
  const { mocks, user } = await open(
    detail("source:s1", "review", {
      files: [{ path: "notes.txt", executable: false }],
    }),
    {
      "GET /api/library/skills/source%3As1/review/file?": () =>
        json({ path: "notes.txt", text: "hello" }),
    },
  );
  const toggle = await screen.findByRole("button", { name: "View file" });
  await user.click(toggle);
  await screen.findByText("hello");
  await user.click(toggle);
  await user.click(toggle);
  await screen.findByText("hello");
  expect(mocks.calls.filter((c) => c.url.includes("/file"))).toHaveLength(1);
});

test("a file the server refuses shows its sentence", async () => {
  const { user } = await open(
    detail("source:s1", "review", { files: [{ path: "a.bin", executable: false }] }),
    {
      "GET /api/library/skills/source%3As1/review/file?": () =>
        json({ error: { code: "validation_error", message: "Not a text file." } }, 400),
    },
  );
  await user.click(await screen.findByRole("button", { name: "View file" }));
  expect(await screen.findByText("Not a text file.")).toBeInTheDocument();
});
