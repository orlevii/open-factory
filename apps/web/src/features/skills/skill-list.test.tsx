import type { ServerMessage } from "@open-factory/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, skill, source, sourceGroup } from "./fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
const ws = vi.hoisted(() => ({ push: (_m: ServerMessage) => {} }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: ServerMessage) => void }) => {
    ws.push = (m) => o.onMessage?.(m);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

beforeEach(() => fakeMatchMedia.install(false));
afterEach(() => vi.restoreAllMocks());

const agents = () => json({ agents: [], more: false, running: { count: 0, max: 8 } });
const api = (data: unknown) =>
  mockApi({
    "GET /api/library/skills": () => json(data),
    "GET /api/agents?": agents,
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
  });

const full = library([
  hostGroup([skill("lint", { usedBy: { templates: 1, agents: 190 } })]),
  sourceGroup(source("skills"), [skill("review"), skill("deploy")]),
  { group: "template:dev", kind: "template", template: "dev", skills: [skill("local")] },
  { group: "unknown", kind: "unknown", skills: [skill("ghost", { state: "missing" })] },
]);

async function open(data: unknown = full) {
  const mocks = api(data);
  const r = renderApp("/skills", alice);
  await screen.findByRole("heading", { level: 1, name: "Skills" });
  return { ...r, mocks };
}

test("groups render in order: Host, each source, Template dev, Unknown, each a list named by its header", async () => {
  await open();
  await screen.findByRole("button", { name: /^lint/ });
  const lists = ["Host", "acme/skills", "Template dev", "Unknown"].map((name) =>
    screen.getByRole("list", { name }),
  );
  lists.slice(1).forEach((list, i) => {
    expect(lists[i]?.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

test("rows and source headers are buttons that open a dialog peek, and say whether theirs is open", async () => {
  await open();
  const row = await screen.findByRole("button", { name: /^review/ });
  expect(row).toHaveAttribute("aria-haspopup", "dialog");
  expect(row).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(row);
  expect(row).toHaveAttribute("aria-expanded", "true");
  expect(row).toHaveAttribute("aria-current", "true");
  const header = screen.getByRole("button", { name: /acme\/skills/ });
  expect(header).toHaveAttribute("aria-haspopup", "dialog");
  await userEvent.click(header);
  expect(header).toHaveAttribute("aria-expanded", "true");
  expect(row).toHaveAttribute("aria-expanded", "false");
});

test("j and k visit source headers as well as skill rows", async () => {
  const user = userEvent.setup();
  await open();
  const lint = await screen.findByRole("button", { name: /^lint/ });
  lint.focus();
  await user.keyboard("j");
  expect(screen.getByRole("button", { name: /acme\/skills/ })).toHaveFocus();
  await user.keyboard("j");
  expect(screen.getByRole("button", { name: /^review/ })).toHaveFocus();
  await user.keyboard("k");
  await user.keyboard("k");
  expect(lint).toHaveFocus();
});

test("with a peek open, j retargets it to the next row", async () => {
  const user = userEvent.setup();
  await open();
  const review = await screen.findByRole("button", { name: /^review/ });
  await user.click(review);
  review.focus();
  await user.keyboard("j");
  const deploy = screen.getByRole("button", { name: /^deploy/ });
  expect(deploy).toHaveFocus();
  expect(deploy).toHaveAttribute("aria-expanded", "true");
  expect(review).toHaveAttribute("aria-expanded", "false");
});

test("Space opens a row's peek and, on the row already shown, closes it", async () => {
  const user = userEvent.setup();
  await open();
  const review = await screen.findByRole("button", { name: /^review/ });
  review.focus();
  await user.keyboard(" ");
  expect(review).toHaveAttribute("aria-expanded", "true");
  await user.keyboard(" ");
  await waitFor(() => expect(review).toHaveAttribute("aria-expanded", "false"));
});

test("a row says what uses it: zero kinds are left out, 'Not used' when none, and a number keeps its noun", async () => {
  await open(
    library([
      hostGroup([
        skill("both", { usedBy: { templates: 3, agents: 2 } }),
        skill("agents-only", { usedBy: { templates: 0, agents: 2 } }),
        skill("many", { usedBy: { templates: 0, agents: 190 } }),
        skill("idle"),
      ]),
    ]),
  );
  // getByText collapses a non-breaking space to a plain one, so the exact text is read from the node.
  expect((await screen.findByText("Used by 3 templates · 2 agents")).textContent).toBe(
    "Used by 3\u00a0templates · 2\u00a0agents",
  );
  expect(screen.getByText("Used by 2 agents").textContent).toBe("Used by 2\u00a0agents");
  expect(screen.getByText("Used by 190 agents").textContent).toBe("Used by 190\u00a0agents");
  expect(screen.getByText("Not used")).toBeInTheDocument();
});

test("a source with several states shows the highest by precedence", async () => {
  await open(
    library([
      hostGroup(),
      sourceGroup(source("both", { update: true, checkFailed: true }), [skill("a")]),
      sourceGroup(source("upd", { update: true }), [skill("b")]),
    ]),
  );
  const both = await screen.findByRole("button", { name: /acme\/both/ });
  expect(within(both).getByText("Couldn't check")).toBeInTheDocument();
  expect(within(both).queryByText("Update available")).toBeNull();
  expect(
    within(screen.getByRole("button", { name: /acme\/upd/ })).getByText("Update available"),
  ).toBeInTheDocument();
});

test("a skill row shows its own state; an ok skill shows none", async () => {
  await open(
    library([
      hostGroup([
        skill("fine"),
        skill("gone", { state: "missing" }),
        skill("odd", { state: "hidden" }),
      ]),
    ]),
  );
  expect(
    within(await screen.findByRole("button", { name: /^gone/ })).getByText("Missing"),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("button", { name: /^odd/ })).getByText("Hidden"),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("button", { name: /^fine/ })).queryByText(/Missing|Hidden|Unusable/),
  ).toBeNull();
});

test("a source header shows its pin as a short sha, 'Live' for a folder, and the skill count", async () => {
  await open(
    library([
      hostGroup(),
      sourceGroup(source("skills", { skillCount: 40 }), [skill("a")]),
      sourceGroup(
        source("dir", {
          kind: "folder",
          path: "/srv/skills",
          repo: null,
          pin: null,
          skillCount: 1,
        }),
        [skill("b")],
      ),
    ]),
  );
  const gh = await screen.findByRole("button", { name: /acme\/skills/ });
  expect(within(gh).getByText("0123456")).toBeInTheDocument();
  expect(within(gh).getByText("40 skills").textContent).toBe("40\u00a0skills");
  const folder = screen.getByRole("button", { name: /\/srv\/skills/ });
  expect(within(folder).getByText("Live")).toBeInTheDocument();
  expect(within(folder).getByText("1 skill").textContent).toBe("1\u00a0skill");
});

test("third-party text is shown with its control characters made visible", async () => {
  await open(library([hostGroup([skill("x", { description: "safe‮evil" })])]));
  expect(await screen.findByText("safe⟨U+202E⟩evil")).toBeInTheDocument();
});

test("the empty state names the host skills folder from the API", async () => {
  await open(library([hostGroup()], "/home/me/.claude/"));
  expect(
    await screen.findByText(/No skills yet\. Add some, or put a folder in/),
  ).toBeInTheDocument();
  expect(screen.getByText("/home/me/.claude/skills")).toBeInTheDocument();
});

test("a failed load says so with Retry, and Retry loads the list", async () => {
  let fail = true;
  mockApi({
    "GET /api/library/skills": () =>
      fail ? json({ error: { code: "x", message: "boom" } }, 500) : json(full),
    "GET /api/agents?": agents,
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/h", sep: "/" }),
  });
  renderApp("/skills", alice);
  expect(await screen.findByText("Couldn't load skills.")).toBeInTheDocument();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: /^lint/ })).toBeInTheDocument();
});

test("arriving with a peek opens it and scrolls its row once; a library_changed afterwards does not scroll again", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const { router, mocks } = await open();
  await screen.findByRole("button", { name: /^review/ });
  expect(scroll).not.toHaveBeenCalled();
  await act(() =>
    router.navigate({
      to: "/skills",
      state: { peek: { kind: "skill", id: "source:skills/review" } } as never,
    }),
  );
  const row = await screen.findByRole("button", { name: /^review/ });
  await waitFor(() => expect(row).toHaveAttribute("aria-expanded", "true"));
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  expect(row).toHaveFocus();
  const before = mocks.calls.filter((c) => c.url === "/api/library/skills").length;
  act(() => ws.push({ type: "library_changed" }));
  await waitFor(() =>
    expect(mocks.calls.filter((c) => c.url === "/api/library/skills").length).toBeGreaterThan(
      before,
    ),
  );
  expect(scroll).toHaveBeenCalledTimes(1);
});

test("a second arrival on the mounted page opens its peek", async () => {
  const { router } = await open();
  await screen.findByRole("button", { name: /^review/ });
  await act(() =>
    router.navigate({
      to: "/skills",
      state: { peek: { kind: "skill", id: "source:skills/review" } } as never,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^review/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    ),
  );
  await act(() =>
    router.navigate({
      to: "/skills",
      state: { peek: { kind: "skill", id: "host/lint" } } as never,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^lint/ })).toHaveAttribute("aria-expanded", "true"),
  );
  expect(screen.getByRole("button", { name: /^review/ })).toHaveAttribute("aria-expanded", "false");
});
