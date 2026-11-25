import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
import { resetDrafts } from "@/features/sheets/drafts";
import { closeSheet } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, skill, source, sourceGroup } from "./fixtures";

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

// The 300 ms inert window is the boundary faked here: its timer is held instead of scheduled, so a test acts inside the
// window and ends it when it chooses, with no real sleeps and no race against a loaded machine.
const windows: (() => void)[] = [];
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  fakeMatchMedia.install(false);
  windows.length = 0;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...a: []
  ) => {
    if (ms === 300) {
      windows.push(fn);
      return 0;
    }
    return realSetTimeout(fn, ms, ...a);
  }) as unknown as typeof setTimeout);
});
const releaseInert = () =>
  act(() => {
    for (const fn of windows.splice(0)) fn();
  });
const posts = (m: { calls: { method: string; url: string; body: unknown }[] }, url: string) =>
  m.calls.filter((c) => c.method === "POST" && c.url === url);
afterEach(() => {
  vi.mocked(globalThis.setTimeout).mockRestore();
  closeSheet();
  resetDrafts();
  vi.clearAllMocks();
});

const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const found = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  description: `${name} description`,
  pickable: true,
  ...o,
});
const preview = (list: unknown[], o: Record<string, unknown> = {}) => ({
  previewId: "p1",
  commit: COMMIT,
  committedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  subject: "Add the skills",
  branch: "main",
  found: list,
  ...o,
});
const added = (o: Record<string, unknown> = {}) => ({
  id: "s9",
  kind: "github",
  path: null,
  repo: "acme/x",
  subpath: null,
  branch: "main",
  pin: COMMIT,
  committedAt: null,
  subject: null,
  state: "ready",
  skills: ["alpha"],
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  usedBy: { templates: 0, agents: 0 },
  ...o,
});

type Handler = Parameters<typeof mockApi>[0][string];
async function open(routes: Record<string, Handler> = {}, groups = [hostGroup([skill("lint")])]) {
  const mocks = mockApi({
    "GET /api/library/skills": () => json(library(groups)),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
    ...routes,
  });
  const user = userEvent.setup();
  renderApp("/skills", alice);
  await user.click(await screen.findByRole("button", { name: "Add skills" }));
  const dialog = await screen.findByRole("dialog", { name: "Add skills" });
  await within(dialog).findByRole("form", { name: "Add skills" });
  return { mocks, user, dialog: within(dialog) };
}
type Dialog = Awaited<ReturnType<typeof open>>["dialog"];

const primary = (d: Dialog, name: RegExp | string) => d.getByRole("button", { name });
const folderFind = async (user: ReturnType<typeof userEvent.setup>, d: Dialog) => {
  await user.type(d.getByLabelText("Path"), "/srv/skills");
  await user.click(primary(d, "Find skills"));
};
const tick = (d: Dialog, name: string) => d.getByRole("checkbox", { name });
const previewRoute = (list: unknown[]) => ({
  "POST /api/library/sources/preview": () => json(preview(list)),
});

test("Folder mode is a path field with its help; GitHub mode shows the three fields with their help", async () => {
  const { user, dialog: d } = await open();
  expect(d.getByLabelText("Path")).toBeInTheDocument();
  expect(
    d.getByText("A skill folder, or a folder of skills, on the factory's machine."),
  ).toBeVisible();
  await user.click(d.getByRole("radio", { name: "GitHub" }));
  expect(d.getByLabelText("Repository")).toBeInTheDocument();
  expect(d.getByLabelText("Path (optional)")).toBeInTheDocument();
  expect(d.getByLabelText("Branch (optional)")).toBeInTheDocument();
  expect(
    d.getByText("owner/repo or a github.com URL. Private repos use this host's git sign-in."),
  ).toBeVisible();
  expect(d.getByText("The folder inside the repo. Empty means the whole repo.")).toBeVisible();
  expect(
    d.getByText("Empty means the default branch. Submodules and LFS files aren't fetched."),
  ).toBeVisible();
});

test.each([
  ["folder", "path", "Can't share your home folder.", "Path"],
  ["github", "branch", "No such branch.", "Branch (optional)"],
  ["github", "repo", "Couldn't reach this repo.", "Repository"],
] as const)("a %s Find error for %s lands on its field", async (mode, field, message, label) => {
  const { user, dialog: d } = await open({
    "POST /api/library/sources/preview": () =>
      json({ error: { code: "validation_error", message, fields: { [field]: message } } }, 400),
  });
  if (mode === "github") {
    await user.click(d.getByRole("radio", { name: "GitHub" }));
    await user.type(d.getByLabelText("Repository"), "acme/x");
    if (field === "branch") await user.type(d.getByLabelText("Branch (optional)"), "nope");
  } else await user.type(d.getByLabelText("Path"), "~/");
  await user.click(primary(d, "Find skills"));
  expect(await d.findByText(message)).toBeVisible();
  expect(d.getByLabelText(label)).toBeInvalid();
});

test("a folder over the size limit is a form-level outcome on Find, not a field error", async () => {
  const message = "Folder is over 50 MB.";
  const { user, dialog: d } = await open({
    "POST /api/library/sources/preview": () => json({ error: { code: "too_large", message } }, 400),
  });
  await folderFind(user, d);
  expect(await d.findByRole("alert")).toHaveTextContent(message);
  expect(d.getByLabelText("Path")).toBeValid();
});

test("a repo that returns another commit is a form-level outcome on Add, not a field error", async () => {
  const message = "The repo returned another commit.";
  const { user, dialog: d } = await open({
    "POST /api/library/sources/preview": () => json(preview([found("alpha")])),
    "POST /api/library/sources": () => json({ error: { code: "commit_mismatch", message } }, 400),
  });
  await user.click(d.getByRole("radio", { name: "GitHub" }));
  await user.type(d.getByLabelText("Repository"), "acme/x");
  await user.click(primary(d, "Find skills"));
  await d.findByText("Found 1 skill");
  await releaseInert();
  await user.click(primary(d, "Add 1\u00a0skill"));
  expect(await d.findByRole("alert")).toHaveTextContent(message);
  expect(d.getByLabelText("Repository")).toBeValid();
});

test("after Find: focus is on the results label and the found line shows", async () => {
  const { user, dialog: d } = await open(
    previewRoute([
      found("alpha"),
      found("beta"),
      found("gamma", { pickable: false, reason: "taken", takenBy: "Host" }),
    ]),
  );
  await folderFind(user, d);
  const label = await d.findByText("Found 3 skills");
  expect(label).toHaveFocus();
  expect(label).toHaveAttribute("tabindex", "-1");
  const line = d.getByText(/Found at/);
  expect(line).toHaveTextContent(/Found at a1b2c3d · main · .*2 days ago · Add the skills/);
});

test("the primary is inert for 300 ms after Find: a click and Enter in a field add nothing, then Add works", async () => {
  const {
    mocks,
    user,
    dialog: d,
  } = await open({
    ...previewRoute([found("alpha"), found("beta")]),
    "POST /api/library/sources": () => json(added(), 201),
  });
  await folderFind(user, d);
  await d.findByText("Found 2 skills");
  expect(windows).toHaveLength(1);
  await user.click(primary(d, "Add 2\u00a0skills"));
  await user.type(d.getByLabelText("Path"), "{Enter}");
  expect(posts(mocks, "/api/library/sources")).toHaveLength(0);
  expect(screen.getByRole("dialog", { name: "Add skills" })).toBeInTheDocument();
  await releaseInert();
  await user.click(primary(d, "Add 2\u00a0skills"));
  await waitFor(() => expect(posts(mocks, "/api/library/sources")).toHaveLength(1));
});

test("rows start ticked when pickable; unpickable rows are disabled with their reasons", async () => {
  const { user, dialog: d } = await open(
    previewRoute([
      found("alpha"),
      found("beta", { pickable: false, reason: "taken", takenBy: "Host" }),
      found("gamma", { pickable: false, reason: "unusable", detail: "SKILL.md names it y" }),
      found("delta", { pickable: false, reason: "link" }),
    ]),
  );
  await folderFind(user, d);
  await d.findByText("Found 4 skills");
  expect(tick(d, "alpha")).toBeChecked();
  for (const n of ["beta", "gamma", "delta"]) expect(tick(d, n)).toBeDisabled();
  expect(d.getByText("Name taken by Host")).toBeVisible();
  expect(d.getByText("SKILL.md names it y")).toBeVisible();
  expect(d.getByText("It's a link")).toBeVisible();
});

test("Select none and Select all act on the filtered rows only; the filter appears past 20 rows", async () => {
  const many = Array.from({ length: 22 }, (_, i) => found(`s${String(i).padStart(2, "0")}`));
  const { user, dialog: d } = await open(previewRoute([...many, found("zeta")]));
  await folderFind(user, d);
  await d.findByText("Found 23 skills");
  await user.type(d.getByRole("searchbox", { name: "Filter skills" }), "zeta");
  expect(d.queryByRole("checkbox", { name: "s00" })).not.toBeInTheDocument();
  await user.click(d.getByRole("button", { name: "Select none" }));
  expect(tick(d, "zeta")).not.toBeChecked();
  expect(d.getByRole("button", { name: "Select all" })).toBeVisible();
  await user.clear(d.getByRole("searchbox", { name: "Filter skills" }));
  expect(tick(d, "s00")).toBeChecked();
  expect(tick(d, "zeta")).not.toBeChecked();
});

test("no filter field up to 20 rows", async () => {
  const { user, dialog: d } = await open(previewRoute([found("alpha")]));
  await folderFind(user, d);
  await d.findByText("Found 1 skill");
  expect(d.queryByRole("searchbox")).not.toBeInTheDocument();
});

test("editing the source marks the results stale, and the next Find keeps the ticks by name", async () => {
  let n = 0;
  const { user, dialog: d } = await open({
    "POST /api/library/sources/preview": () =>
      json(
        preview(
          n++ === 0
            ? [found("alpha"), found("beta")]
            : [found("beta"), found("alpha"), found("new")],
        ),
      ),
  });
  await folderFind(user, d);
  await d.findByText("Found 2 skills");
  await user.click(tick(d, "beta"));
  await user.type(d.getByLabelText("Path"), "/x");
  await releaseInert();
  expect(d.getByText("The source changed. Find skills again.")).toBeVisible();
  expect(tick(d, "alpha")).toBeDisabled();
  await user.click(primary(d, "Find skills"));
  await d.findByText("Found 3 skills");
  expect(tick(d, "alpha")).toBeChecked();
  expect(tick(d, "beta")).not.toBeChecked();
  expect(tick(d, "new")).toBeChecked();
});

test("every row unpickable: None of these can be added, and Add stays disabled", async () => {
  const { user, dialog: d } = await open(
    previewRoute([found("alpha", { pickable: false, reason: "link" })]),
  );
  await folderFind(user, d);
  expect(await d.findByText("None of these can be added.")).toBeVisible();
  expect(primary(d, "Add 0\u00a0skills")).toHaveAttribute("aria-disabled", "true");
});

test("zero found says so and Add stays disabled", async () => {
  const { user, dialog: d } = await open(previewRoute([]));
  await folderFind(user, d);
  expect(
    await d.findByText(
      /No skills in \/srv\/skills at a1b2c3d\. A skill is a folder with a SKILL\.md\./,
    ),
  ).toBeVisible();
  expect(primary(d, "Add 0\u00a0skills")).toHaveAttribute("aria-disabled", "true");
});

test("Add at 0 picks is inert and its note describes the primary", async () => {
  const {
    mocks,
    user,
    dialog: d,
  } = await open({
    ...previewRoute([found("alpha")]),
    "POST /api/library/sources": () => json(added(), 201),
  });
  await folderFind(user, d);
  await d.findByText("Found 1 skill");
  await releaseInert();
  await user.click(tick(d, "alpha"));
  const add = primary(d, "Add 0\u00a0skills");
  expect(add).toHaveAttribute("aria-disabled", "true");
  expect(add).toHaveAccessibleDescription("Pick at least one skill.");
  await user.click(add);
  await user.type(d.getByLabelText("Path"), "{Enter}");
  expect(posts(mocks, "/api/library/sources")).toHaveLength(0);
});

test("a stale zero-found result says the source changed", async () => {
  const { user, dialog: d } = await open(previewRoute([]));
  await folderFind(user, d);
  await d.findByText(/No skills in/);
  await user.type(d.getByLabelText("Path"), "/more");
  expect(d.getByText("The source changed. Find skills again.")).toBeVisible();
});

test("Add posts the picks, closes the sheet and toasts 'Added 2\u00a0skills.' with Undo that deletes the source", async () => {
  const del = vi.fn(() => json({ undoUntil: new Date(Date.now() + 30_000).toISOString() }));
  const {
    mocks,
    user,
    dialog: d,
  } = await open({
    ...previewRoute([found("alpha"), found("beta")]),
    "POST /api/library/sources": () => json(added(), 201),
    "DELETE /api/library/sources/s9": del,
  });
  await folderFind(user, d);
  await d.findByText("Found 2 skills");
  await releaseInert();
  await user.click(primary(d, "Add 2\u00a0skills"));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add skills" })).not.toBeInTheDocument(),
  );
  expect(
    mocks.calls.find((c) => c.method === "POST" && c.url === "/api/library/sources")?.body,
  ).toEqual({
    kind: "folder",
    path: "/srv/skills",
    skills: ["alpha", "beta"],
  });
  const call = vi.mocked(notify).mock.calls.at(-1)?.[0];
  expect(call?.text).toBe("Added 2\u00a0skills.");
  await call?.undo?.();
  expect(del).toHaveBeenCalled();
});

test("a 202 closes the sheet with no toast, and the source shows as a pending header", async () => {
  let listed = false;
  const { user, dialog: d } = await open({
    "POST /api/library/sources/preview": () => json(preview([found("alpha")])),
    "POST /api/library/sources": () => {
      listed = true;
      return json(added({ state: "adding" }), 202);
    },
    "GET /api/library/skills": () =>
      json(
        library(
          listed
            ? [
                hostGroup(),
                sourceGroup(
                  source("s9", {
                    state: "adding",
                    pin: null,
                    since: new Date().toISOString(),
                    skillCount: 0,
                  }),
                  [],
                ),
              ]
            : [hostGroup([skill("lint")])],
        ),
      ),
  });
  await user.click(d.getByRole("radio", { name: "GitHub" }));
  await user.type(d.getByLabelText("Repository"), "acme/s9");
  await user.click(primary(d, "Find skills"));
  await d.findByText("Found 1 skill");
  await releaseInert();
  await user.click(primary(d, "Add 1\u00a0skill"));
  expect(await screen.findByRole("button", { name: /acme\/s9.*Adding/ })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "Add skills" })).not.toBeInTheDocument();
  expect(notify).not.toHaveBeenCalled();
});

test("Close during Find aborts the request and keeps the draft", async () => {
  let signal: AbortSignal | undefined;
  const { user, dialog: d } = await open({
    "POST /api/library/sources/preview": () => new Promise<Response>(() => {}),
  });
  await user.type(d.getByLabelText("Path"), "/srv/skills");
  await user.click(primary(d, "Find skills"));
  await waitFor(() => {
    const call = vi.mocked(fetch).mock.calls.find(([u]) => u === "/api/library/sources/preview");
    signal = (call?.[1] as RequestInit | undefined)?.signal ?? undefined;
    expect(signal).toBeDefined();
  });
  expect(signal?.aborted).toBe(false);
  await user.click(
    within(d.getByRole("form", { name: "Add skills" })).getByRole("button", { name: "Close" }),
  );
  expect(signal?.aborted).toBe(true);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add skills" })).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: "Add skills" }));
  const again = within(await screen.findByRole("dialog", { name: "Add skills" }));
  expect(again.getByLabelText("Path")).toHaveValue("/srv/skills");
});

test("dismissing the sheet another way (Esc) unmounts it and aborts a running Find", async () => {
  const { user, dialog: d } = await open({
    "POST /api/library/sources/preview": () => new Promise<Response>(() => {}),
  });
  await user.type(d.getByLabelText("Path"), "/srv/skills");
  await user.click(primary(d, "Find skills"));
  let signal: AbortSignal | undefined;
  await waitFor(() => {
    const call = vi.mocked(fetch).mock.calls.find(([u]) => u === "/api/library/sources/preview");
    signal = (call?.[1] as RequestInit | undefined)?.signal ?? undefined;
    expect(signal).toBeDefined();
  });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(signal?.aborted).toBe(true));
});

const deferred = () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

test.each([
  ["folder", "relative/path", "Path", "Start with / or ~/."],
  ["github", "", "Repository", "Use owner/repo or a github.com URL."],
  ["github-branch", "bad..name", "Branch (optional)", "No such branch."],
  ["github-subpath", "../up", "Path (optional)", "Not a folder in this repo."],
] as const)(
  "%s: a bad value is refused before any request",
  async (mode, value, label, message) => {
    const { mocks, user, dialog: d } = await open(previewRoute([found("alpha")]));
    if (mode !== "folder") await user.click(d.getByRole("radio", { name: "GitHub" }));
    if (mode.startsWith("github-")) await user.type(d.getByLabelText("Repository"), "acme/x");
    if (value) await user.type(d.getByLabelText(label), value);
    await user.click(primary(d, "Find skills"));
    expect(await d.findByText(message)).toBeVisible();
    expect(posts(mocks, "/api/library/sources/preview")).toHaveLength(0);
  },
);

test("a GitHub Find sends the trimmed fields and leaves out an empty path and branch", async () => {
  const { mocks, user, dialog: d } = await open(previewRoute([found("alpha")]));
  await user.click(d.getByRole("radio", { name: "GitHub" }));
  await user.type(d.getByLabelText("Repository"), " acme/x ");
  await user.click(primary(d, "Find skills"));
  await d.findByText("Found 1 skill");
  expect(posts(mocks, "/api/library/sources/preview")[0]?.body).toEqual({
    kind: "github",
    repo: "acme/x",
  });
  await releaseInert();
  await user.type(d.getByLabelText("Path (optional)"), " skills ");
  await user.type(d.getByLabelText("Branch (optional)"), "dev");
  await user.click(primary(d, "Find skills"));
  await waitFor(() => expect(posts(mocks, "/api/library/sources/preview")).toHaveLength(2));
  expect(posts(mocks, "/api/library/sources/preview")[1]?.body).toEqual({
    kind: "github",
    repo: "acme/x",
    subpath: "skills",
    branch: "dev",
  });
});

test("a failed Add keeps the sheet open with the draft and a form-level error", async () => {
  const {
    mocks,
    user,
    dialog: d,
  } = await open({
    ...previewRoute([found("alpha")]),
    "POST /api/library/sources": () =>
      json({ error: { code: "name_taken", message: "A chosen skill's name was taken." } }, 409),
  });
  await folderFind(user, d);
  await d.findByText("Found 1 skill");
  await releaseInert();
  await user.click(primary(d, "Add 1\u00a0skill"));
  expect(await d.findByRole("alert")).toHaveTextContent("A chosen skill's name was taken.");
  expect(posts(mocks, "/api/library/sources")).toHaveLength(1);
  expect(d.getByLabelText("Path")).toHaveValue("/srv/skills");
  expect(vi.mocked(notify)).not.toHaveBeenCalled();
});

test("a restored draft says so, and Discard clears it", async () => {
  const { user, dialog: d } = await open();
  await user.type(d.getByLabelText("Path"), "/srv/skills");
  await user.click(
    within(d.getByRole("form", { name: "Add skills" })).getByRole("button", { name: "Close" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add skills" })).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: "Add skills" }));
  const again = within(await screen.findByRole("dialog", { name: "Add skills" }));
  expect(await again.findByText("Draft restored")).toBeVisible();
  expect(again.getByLabelText("Path")).toHaveValue("/srv/skills");
  await user.click(again.getByRole("button", { name: "Discard" }));
  expect(again.getByLabelText("Path")).toHaveValue("");
  expect(again.queryByText("Draft restored")).not.toBeInTheDocument();
});

test("an Add that finishes after the sheet was closed toasts, and clears the draft it submitted", async () => {
  const post = deferred();
  const { user, dialog: d } = await open({
    ...previewRoute([found("alpha")]),
    "POST /api/library/sources": () => post.promise,
  });
  await folderFind(user, d);
  await d.findByText("Found 1 skill");
  await releaseInert();
  await user.click(primary(d, "Add 1\u00a0skill"));
  await user.click(
    within(d.getByRole("form", { name: "Add skills" })).getByRole("button", { name: "Close" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add skills" })).not.toBeInTheDocument(),
  );
  await act(async () => post.resolve(json(added(), 201)));
  await waitFor(() =>
    expect(vi.mocked(notify).mock.calls.at(-1)?.[0].text).toBe("Added 1\u00a0skill."),
  );
  await user.click(screen.getByRole("button", { name: "Add skills" }));
  const again = within(await screen.findByRole("dialog", { name: "Add skills" }));
  expect(await again.findByLabelText("Path")).toHaveValue("");
  expect(again.queryByText("Draft restored")).not.toBeInTheDocument();
});

test("an Add that fails after the sheet was closed toasts the reason and keeps the draft", async () => {
  const post = deferred();
  const { user, dialog: d } = await open({
    ...previewRoute([found("alpha")]),
    "POST /api/library/sources": () => post.promise,
  });
  await folderFind(user, d);
  await d.findByText("Found 1 skill");
  await releaseInert();
  await user.click(primary(d, "Add 1\u00a0skill"));
  await user.click(
    within(d.getByRole("form", { name: "Add skills" })).getByRole("button", { name: "Close" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Add skills" })).not.toBeInTheDocument(),
  );
  await act(async () =>
    post.resolve(
      json({ error: { code: "pin_moved", message: "This source changed. Try again." } }, 409),
    ),
  );
  await waitFor(() =>
    expect(vi.mocked(notify).mock.calls.at(-1)?.[0].text).toBe("This source changed. Try again."),
  );
  await user.click(screen.getByRole("button", { name: "Add skills" }));
  const again = within(await screen.findByRole("dialog", { name: "Add skills" }));
  expect(await again.findByLabelText("Path")).toHaveValue("/srv/skills");
});
