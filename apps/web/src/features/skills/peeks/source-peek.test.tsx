import type { ServerMessage } from "@open-factory/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notify } from "@/components/ui/toaster";
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
vi.mock("@/components/ui/toaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toaster")>();
  return { ...actual, notify: vi.fn(actual.notify) };
});

beforeEach(() => fakeMatchMedia.install(false));
afterEach(() => vi.clearAllMocks());

const OLD = "0123456789abcdef0123456789abcdef01234567";
const NEW = "e4f5a6b1111111111111111111111111111111aa";

const names = (n: number) => Array.from({ length: n }, (_, i) => `skill-${i + 1}`);

const detail = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  kind: "github",
  path: null,
  repo: `acme/${id}`,
  subpath: null,
  branch: "main",
  pin: OLD,
  committedAt: "2026-11-01T10:00:00Z",
  subject: "Fix the reviewer",
  state: "ready",
  skills: ["review"],
  updateCommit: null,
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  usedBy: { templates: 0, agents: 0 },
  update: null,
  ...o,
});

const updateView = (o: Record<string, unknown> = {}) => ({
  from: OLD,
  to: NEW,
  committedAt: "2026-11-20T10:00:00Z",
  subject: "Add a guard hook",
  compareUrl: `https://github.com/acme/skills/compare/${OLD.slice(0, 7)}...${NEW.slice(0, 7)}`,
  changed: [
    {
      name: "review",
      runsCodeChanged: true,
      hooks: {
        added: [{ event: "PreToolUse", matcher: "Bash", command: "./guard.sh" }],
        removed: [{ event: "Stop", matcher: "", command: "./old.sh" }],
      },
      execFiles: ["bin/run.sh"],
    },
    { name: "deploy", runsCodeChanged: false, hooks: { added: [], removed: [] }, execFiles: [] },
  ],
  removed: [],
  added: [],
  unusable: [],
  ...o,
});

type Mocks = ReturnType<typeof mockApi>;

async function open(
  view: Record<string, unknown> = detail("skills"),
  extra: (m: Mocks) => void = () => {},
  data = library([
    hostGroup(),
    sourceGroup(source("skills", { skillCount: 1 }), [skill("review")]),
    sourceGroup(source("other"), [skill("lint")]),
  ]),
) {
  const mocks = mockApi({
    "GET /api/library/skills": () => json(data),
    "GET /api/library/sources/skills": () => json(view),
    "GET /api/library/sources/other": () => json(detail("other", { skills: ["lint"] })),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
  });
  extra(mocks);
  const user = userEvent.setup();
  renderApp("/skills", alice);
  await user.click(await screen.findByRole("button", { name: /acme\/skills/ }));
  await screen.findByRole("heading", { level: 3, name: "Source" });
  return { mocks, user };
}

const withUpdate = detail("skills", {
  updateCommit: NEW,
  update: updateView(),
});

test("the update view is open as soon as the source has an update commit", async () => {
  await open(withUpdate);
  expect(await screen.findByRole("button", { name: "Update to e4f5a6b" })).toBeInTheDocument();
});

test("a source whose last check failed shows Couldn't check and the stored message", async () => {
  await open(detail("skills", { checkError: "Couldn't reach github.com." }));
  expect(await screen.findByText("Couldn't check")).toBeInTheDocument();
  expect(screen.getByText("Couldn't reach github.com.")).toBeInTheDocument();
});

test("a source whose last check succeeded shows no failed-check state", async () => {
  await open();
  expect(screen.queryByText("Couldn't check")).not.toBeInTheDocument();
});

test("a source with no update has no update view", async () => {
  await open();
  expect(screen.queryByRole("button", { name: /^Update to/ })).not.toBeInTheDocument();
});

test("a skill whose code changed says so, first, with its hooks and executables as + and − lines", async () => {
  await open(withUpdate);
  const items = await screen.findAllByRole("listitem");
  const changed = items.filter((li) => within(li).queryByText("Runs code changed"));
  expect(changed).toHaveLength(1);
  const [first] = changed;
  const text = first?.textContent ?? "";
  expect(text).toContain("PreToolUse (Bash): ./guard.sh");
  expect(text).toContain("Stop: ./old.sh");
  expect(text).toContain("bin/run.sh");
  expect(within(first as HTMLElement).getAllByText("Added")).toHaveLength(2);
  expect(within(first as HTMLElement).getByText("Removed")).toBeInTheDocument();
  // review (runs code changed) is listed before deploy.
  const all = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
  expect(all.findIndex((t) => t.includes("Runs code changed"))).toBeLessThan(
    all.findIndex((t) => t.startsWith("deploy")),
  );
});

test("the compare link opens a new tab without a referrer", async () => {
  await open(withUpdate);
  const link = await screen.findByRole("link", { name: /Compare on GitHub/ });
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(link).toHaveAttribute("href", expect.stringContaining("/compare/"));
});

test("while the server builds a slow update view the section says so, then shows the view", async () => {
  let resolve: (r: Response) => void = () => {};
  await open(
    withUpdate,
    (m) =>
      m.on("GET /api/library/sources/skills", () => new Promise<Response>((r) => (resolve = r))),
    library([
      hostGroup(),
      sourceGroup(source("skills", { update: true }), [skill("review")]),
      sourceGroup(source("other"), [skill("lint")]),
    ]),
  );
  expect(await screen.findByText("Preparing update…")).toBeInTheDocument();
  resolve(json(withUpdate));
  expect(await screen.findByRole("button", { name: "Update to e4f5a6b" })).toBeInTheDocument();
  expect(screen.queryByText("Preparing update…")).not.toBeInTheDocument();
});

test("Update to e4f5a6b posts the commit the check found, and says it worked after the update view is gone", async () => {
  let updated = false;
  const { mocks, user } = await open(withUpdate, (m) => {
    m.on("GET /api/library/sources/skills", () =>
      json(updated ? detail("skills", { pin: NEW }) : withUpdate),
    );
    m.on("POST /api/library/sources/skills/update", () => {
      updated = true;
      return json(detail("skills", { pin: NEW }));
    });
  });
  await user.click(await screen.findByRole("button", { name: "Update to e4f5a6b" }));
  await waitFor(() =>
    expect(mocks.calls.find((c) => c.url.endsWith("/skills/update"))?.body).toEqual({
      commit: NEW,
    }),
  );
  expect(await screen.findByText("Updated to e4f5a6b.")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^Update to/ })).not.toBeInTheDocument(),
  );
  expect(screen.getByText("Updated to e4f5a6b.")).toBeInTheDocument();
});

test("skills that run code differently come first whatever order the server sent", async () => {
  const view = updateView();
  await open(
    detail("skills", {
      updateCommit: NEW,
      update: { ...view, changed: [...view.changed].reverse() },
    }),
  );
  await screen.findByText("Runs code changed");
  const all = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
  expect(all.findIndex((t) => t.includes("Runs code changed"))).toBeLessThan(
    all.findIndex((t) => t.startsWith("deploy")),
  );
});

test("a compare link that isn't on GitHub over https is not rendered", async () => {
  await open(
    detail("skills", {
      updateCommit: NEW,
      update: updateView({ compareUrl: "https://evil.example/compare/a...b" }),
    }),
  );
  await screen.findByRole("button", { name: "Update to e4f5a6b" });
  expect(screen.queryByRole("link", { name: /Compare/ })).not.toBeInTheDocument();
});

test("a branch with a bidi override shows the token", async () => {
  await open(detail("skills", { branch: "ma\u202Ein" }));
  expect(await screen.findByText("ma⟨U+202E⟩in")).toBeInTheDocument();
});

test("retargeting while a removal is in flight still offers Undo", async () => {
  let resolve: (r: Response) => void = () => {};
  const { user } = await open(detail("skills"), (m) => {
    m.on("DELETE /api/library/sources/skills", () => new Promise<Response>((r) => (resolve = r)));
    m.on("POST /api/library/sources/skills/restore", () => json(detail("skills")));
  });
  await user.click(await screen.findByRole("button", { name: /^Remove source/ }));
  await user.click(screen.getByRole("button", { name: /^acme\/other/ }));
  await screen.findByRole("heading", { level: 3, name: "Source" });
  resolve(json({ undoUntil: new Date(Date.now() + 30_000).toISOString() }));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  expect(vi.mocked(notify).mock.calls[0]?.[0].undo).toBeTypeOf("function");
});

test("a refused update shows in the outcome line with its users as links", async () => {
  const { user } = await open(withUpdate, (m) =>
    m.on("POST /api/library/sources/skills/update", () =>
      json(
        {
          error: {
            code: "update_drops_used",
            message: "Update would remove skill gone, used by template dev, @ana.",
            skills: ["gone"],
            templates: ["dev"],
            agents: ["ana"],
          },
        },
        409,
      ),
    ),
  );
  await user.click(await screen.findByRole("button", { name: "Update to e4f5a6b" }));
  expect(await screen.findByRole("link", { name: "dev" })).toHaveAttribute(
    "href",
    "/templates/dev",
  );
  const line = screen.getByRole("link", { name: "dev" }).closest("[role=alert]");
  expect(line?.textContent).toMatch(
    /^Update would remove skill gone, used by template dev, @ana\.$/,
  );
  expect(screen.getByRole("link", { name: "@ana" })).toHaveAttribute("href", "/agents/ana");
});

test("Remove source is aria-disabled while the source is used, pointing at the reason, and stays focusable", async () => {
  const { mocks, user } = await open(
    detail("skills", { skills: names(40), usedBy: { templates: 1, agents: 2 } }),
    undefined,
    library([
      hostGroup(),
      sourceGroup(
        source("skills", { skillCount: 40 }),
        names(40).map((n) => skill(n)),
      ),
    ]),
  );
  const button = await screen.findByRole("button", { name: /Remove source \(40\s+skills\)/ });
  expect(button).toHaveAttribute("aria-disabled", "true");
  const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
  expect(reason?.textContent).toMatch(
    /Used by 1\s+template · 2\s+agents\. Remove it from them first\./,
  );
  button.focus();
  expect(button).toHaveFocus();
  await user.click(button);
  expect(mocks.calls.some((c) => c.method === "DELETE")).toBe(false);
});

test("removing a source moves focus to the next source header and offers Undo for the server's window", async () => {
  const { mocks, user } = await open(detail("skills"), (m) => {
    m.on("DELETE /api/library/sources/skills", () =>
      json({ undoUntil: new Date(Date.now() + 30_000).toISOString() }),
    );
    m.on("POST /api/library/sources/skills/restore", () => json(detail("skills")));
  });
  await user.click(await screen.findByRole("button", { name: /^Remove source/ }));
  await waitFor(() => expect(notify).toHaveBeenCalled());
  const n = vi.mocked(notify).mock.calls[0]?.[0];
  expect(n?.text).toMatch(/^Removed acme\/skills and its 1\s+skill\.$/);
  expect(n?.durationMs).toBeGreaterThan(28_000);
  expect(n?.durationMs).toBeLessThanOrEqual(30_000);
  await waitFor(() => expect(screen.getByRole("button", { name: /acme\/other/ })).toHaveFocus());
  // A toast shown by an earlier test may still be on screen: the newest one is last.
  await user.click((await screen.findAllByRole("button", { name: "Undo" })).at(-1) as HTMLElement);
  await waitFor(() =>
    expect(mocks.calls.some((c) => c.url === "/api/library/sources/skills/restore")).toBe(true),
  );
});

test("a refused removal shows its users as links, and nothing is removed", async () => {
  const { user } = await open(detail("skills"), (m) =>
    m.on("DELETE /api/library/sources/skills", () =>
      json(
        {
          error: {
            code: "in_use",
            message: "Used by template dev.",
            templates: ["dev"],
            agents: [],
          },
        },
        409,
      ),
    ),
  );
  await user.click(await screen.findByRole("button", { name: /^Remove source/ }));
  expect(await screen.findByRole("link", { name: "dev" })).toHaveAttribute(
    "href",
    "/templates/dev",
  );
  expect(notify).not.toHaveBeenCalled();
});

test("Find more skills lists results inline and adds the ticked ones with an inline outcome, no toast and no Undo", async () => {
  const { mocks, user } = await open(detail("skills"), (m) => {
    m.on("POST /api/library/sources/skills/find", () =>
      json({
        found: [
          { name: "alpha", description: "first", pickable: true },
          { name: "beta", description: "second", pickable: true },
          { name: "taken", description: "x", pickable: false, reason: "taken", takenBy: "Host" },
        ],
      }),
    );
    m.on("POST /api/library/sources/skills/add", () =>
      json(detail("skills", { skills: ["review", "alpha", "beta"] })),
    );
  });
  await user.click(await screen.findByRole("button", { name: "Find more skills" }));
  expect(await screen.findByRole("checkbox", { name: "alpha" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "taken" })).toBeDisabled();
  expect(screen.getByText("Name taken by Host")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Add 2\s+skills to this source$/ }));
  expect(await screen.findByText(/^Added 2\s+skills\.$/)).toBeInTheDocument();
  expect(mocks.calls.find((c) => c.url.endsWith("/skills/add"))?.body).toEqual({
    skills: ["alpha", "beta"],
  });
  expect(notify).not.toHaveBeenCalled();
  expect(
    within(screen.getByRole("dialog")).queryByRole("button", { name: "Undo" }),
  ).not.toBeInTheDocument();
});

const findRoute = (list: unknown[]) => (m: Mocks) =>
  m.on("POST /api/library/sources/skills/find", () => json({ found: list }));
const findMore = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: "Find more skills" }));
const pick = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `s${String(i).padStart(2, "0")}`,
    description: `desc ${i}`,
    pickable: true,
  }));

test("Find more skills filters past 20 results and Select none and Select all act on the shown rows", async () => {
  const { user } = await open(
    detail("skills"),
    findRoute([...pick(22), { ...pick(1)[0], name: "zeta", description: "z" }]),
  );
  await findMore(user);
  await user.type(await screen.findByRole("searchbox", { name: "Filter skills" }), "zeta");
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Select none" }));
  expect(screen.getByRole("checkbox", { name: "zeta" })).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: /^Add 22\s+skills to this source$/ }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Select all" }));
  expect(
    screen.getByRole("button", { name: /^Add 23\s+skills to this source$/ }),
  ).toBeInTheDocument();
});

test("Find more skills with nothing pickable says so and its Add stays disabled", async () => {
  const { user } = await open(
    detail("skills"),
    findRoute([
      { name: "taken", description: "x", pickable: false, reason: "taken", takenBy: "Host" },
    ]),
  );
  await findMore(user);
  expect(await screen.findByText("None of these can be added.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Add 0\s+skills to this source$/ })).toBeDisabled();
});

test("Find more skills with no results says there are no more skills to add", async () => {
  const { user } = await open(detail("skills"), findRoute([]));
  await findMore(user);
  expect(await screen.findByText("No more skills to add.")).toBeInTheDocument();
});

test("removing the last source moves focus to the header's Add skills button", async () => {
  const { user } = await open(
    detail("skills"),
    (m) =>
      m.on("DELETE /api/library/sources/skills", () =>
        json({ undoUntil: new Date(Date.now() + 30_000).toISOString() }),
      ),
    library([hostGroup(), sourceGroup(source("skills", { skillCount: 1 }), [skill("review")])]),
  );
  await user.click(await screen.findByRole("button", { name: /^Remove source/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Add skills" })).toHaveFocus());
});

test("the pin button copies the full commit and names it", async () => {
  const { user } = await open();
  const pin = await screen.findByRole("button", { name: `Copy commit ${OLD}` });
  expect(pin).toHaveTextContent(OLD.slice(0, 7));
  await user.click(pin);
  expect(await navigator.clipboard.readText()).toBe(OLD);
  expect(screen.getAllByText(OLD).length).toBeGreaterThan(0);
});
