import {
  eventsQuerySchema,
  type ServerMessage,
  type SessionEvent,
  taskCommentBodySchema,
} from "@open-factory/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getSheetState, resetSheets } from "@/features/sheets/sheet-store";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { type Handler, json, type MockApi, mockApi, validBody, validQuery } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { detail as agentDetail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
// The dwell read is inbox-pane.test's; here an item shown is read only by a reply, so the reply's
// read is what the tests see.
vi.mock("@/lib/timing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/timing")>()),
  INBOX_DWELL_MS: 600_000,
}));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onOpen?: () => void }) => {
    setTimeout(() => o.onOpen?.(), 0);
    return { close() {}, status: () => "open", send: (_: ServerMessage) => true };
  },
}));

const original = window.matchMedia;
const originalScroll = Element.prototype.scrollIntoView;
afterEach(() => {
  window.matchMedia = original;
  Element.prototype.scrollIntoView = originalScroll;
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const at = (m: number) => new Date(2026, 10, 19, 14, m).toISOString();
type Over = Record<string, unknown>;
const item = (n: number, o: Over = {}) => ({
  id: `i${n}`,
  messageId: `m${n}`,
  kind: "notice",
  read: false,
  from: { kind: "agent", name: "dev" },
  to: "@alice",
  preview: `preview ${n}`,
  urgent: false,
  createdAt: at(50 - n),
  link: { kind: "session", agentSlug: "dev", seq: 42 },
  ...o,
});

/** Events `from..to`, each an assistant text "event <seq>" (one row each). */
const events = (slug: string, from: number, to: number): SessionEvent[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    seq: from + i,
    agentSlug: slug,
    turnId: "t1",
    at: at(i),
    event: { type: "assistant_text", text: `${slug} event ${from + i}` },
  }));
const page = (evs: SessionEvent[]) => ({ events: evs, hasMore: { before: true, after: false } });

/** The events route as the server answers it: the real query schema, `around` or the latest. */
const eventsRoute =
  (slug: string): Handler =>
  (_b, url) => {
    const q = new URL(url, "http://x").searchParams;
    const around = q.get("around");
    return around
      ? json(page(events(slug, Number(around) - 3, Number(around) + 3)))
      : json(page(events(slug, 94, 100)));
  };

const comment = (id: string, author: Over, m: number) => ({
  type: "comment",
  id,
  author,
  body: `comment ${id}`,
  at: at(m),
});
const task = (o: Over = {}) => ({
  key: "T-7",
  title: "Seven",
  status: "in_progress",
  assignee: { slug: "dev", displayName: "Dev agent" },
  blockedBy: [],
  createdBy: { kind: "user", handle: "alice" },
  updatedAt: at(10),
  body: "",
  createdAt: at(0),
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [
    comment("c0", { kind: "user", handle: "alice" }, 1),
    comment("c1", { kind: "agent", slug: "ada" }, 2),
    comment("c2", { kind: "user", handle: "alice" }, 3),
    comment("c3", { kind: "agent", slug: "dev" }, 4),
    {
      type: "event",
      id: "e1",
      actor: { kind: "agent", slug: "dev" },
      event: "status",
      from: "open",
      to: "in_progress",
      at: at(4),
    },
    comment("c4", { kind: "agent", slug: "ada" }, 5),
    comment("c5", { kind: "user", handle: "bob" }, 6),
    comment("h1", { kind: "user", handle: "bob" }, 7),
  ],
  usage: null,
  ...o,
});

let api: MockApi;
function setup(items: unknown[]) {
  api = mockApi({
    "GET /api/inbox?": () => json({ chats: [], items, nextCursor: null }),
    "GET /api/inbox/unread-count": () => json({ count: items.length, byAgent: {} }),
    "GET /api/agents/dev": () => json(agentDetail()),
    "GET /api/agents/dev/events?": validQuery(eventsQuerySchema, eventsRoute("dev")),
    "GET /api/tasks/T-7": () => json(task()),
  });
  for (const i of items as { id: string }[])
    api.on(`POST /api/inbox/${i.id}/read`, () => json({ ok: true }));
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const reads = () =>
  api.calls.filter((c) => c.method === "POST" && /\/api\/inbox\/[^/]+\/read$/.test(c.url));
const pane = () => screen.getByRole("region", { name: "Reading pane" });

async function visit(path: string) {
  fakeMatchMedia.installWidth(1280);
  const app = renderApp(path, alice);
  await waitFor(() => expect(document.querySelector("a[data-inbox-id]")).not.toBeNull());
  return app;
}

const mention = (n: number, commentId: string, from: Over) =>
  item(n, {
    kind: "mention",
    from,
    task: { key: "T-7", title: "Seven" },
    link: { kind: "task", key: "T-7", commentId },
  });

test("a mention shows the task header, the 3 comments before it and the comment, and a composer prefilled with the agent author", async () => {
  setup([mention(1, "c4", { kind: "agent", name: "ada" })]);
  api.on(
    "POST /api/tasks/T-7/comments",
    validBody(taskCommentBodySchema, (b) =>
      json(
        {
          comment: {
            type: "comment",
            id: "c9",
            author: { kind: "user", handle: "alice" },
            body: (b as { body: string }).body,
            at: at(9),
          },
          deliveredTo: ["ada"],
          mentionedHumans: [],
          notReached: [],
        },
        201,
      ),
    ),
  );
  await visit("/inbox?item=i1");
  const p = pane();
  await waitFor(() => expect(within(p).getByText("comment c4")).toBeInTheDocument());
  expect(within(p).getByText("T-7")).toBeInTheDocument();
  expect(within(p).getByRole("heading", { name: "Seven" })).toBeInTheDocument();
  expect(within(p).getByText("In progress")).toBeInTheDocument();
  expect(within(p).getByText("Dev agent")).toBeInTheDocument();
  for (const c of ["c1", "c2", "c3", "c4"])
    expect(within(p).getByText(`comment ${c}`)).toBeInTheDocument();
  expect(within(p).queryByText("comment c0")).toBeNull();
  expect(within(p).queryByText("comment c5")).toBeNull();
  const box = within(p).getByRole("combobox", { name: "Comment" });
  await waitFor(() => expect(box).toHaveValue("@ada "));
  expect(reads()).toHaveLength(0);
  await userEvent.type(box, "thanks");
  fireEvent.click(within(p).getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.calls.find((c) => c.url === "/api/tasks/T-7/comments")?.body).toEqual({
      body: "@ada thanks",
    }),
  );
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i1/read"]));
});

test("a mention brings the mentioned comment to the top of the body; the composer can't take the body's room", async () => {
  setup([mention(1, "c4", { kind: "agent", name: "ada" })]);
  await visit("/inbox?item=i1");
  const p = pane();
  await waitFor(() => expect(within(p).getByText("comment c4")).toBeInTheDocument());
  const lit = p.querySelector("[data-highlighted]");
  expect(lit).toHaveTextContent("comment c4");
  // jsdom has no layout: the call is what it can see; the result is a browser check.
  await waitFor(() =>
    expect(
      vi
        .mocked(Element.prototype.scrollIntoView)
        .mock.calls.some(
          (call, i) =>
            vi.mocked(Element.prototype.scrollIntoView).mock.contexts[i] === lit &&
            (call[0] as ScrollIntoViewOptions | undefined)?.block === "start",
        ),
    ).toBe(true),
  );
  // The composer is capped and scrolls within itself, so the body always keeps room.
  const box = within(p).getByRole("combobox", { name: "Comment" });
  const composer = box.closest("[data-pane-composer]") as HTMLElement;
  expect(composer).not.toBeNull();
  expect(composer).toHaveClass("overflow-y-auto");
  expect(composer.className).toMatch(/max-h-/);
});

test("a mention by a human leaves the composer empty", async () => {
  setup([mention(1, "h1", { kind: "human", name: "bob" })]);
  await visit("/inbox?item=i1");
  const p = pane();
  await waitFor(() => expect(within(p).getByText("comment h1")).toBeInTheDocument());
  expect(within(p).getByRole("combobox", { name: "Comment" })).toHaveValue("");
});

test("a task event shows the fact and Open task, with no composer", async () => {
  setup([
    item(1, {
      kind: "task_event",
      from: { kind: "agent", name: "dev" },
      task: { key: "T-7", title: "Seven" },
      fact: "done",
      link: { kind: "task", key: "T-7" },
    }),
  ]);
  api.on("GET /api/tasks/T-7", () =>
    json(
      task({
        status: "done",
        activity: [
          {
            type: "event",
            id: "e9",
            actor: { kind: "agent", slug: "dev" },
            event: "status",
            from: "in_progress",
            to: "done",
            at: at(30),
          },
        ],
      }),
    ),
  );
  await visit("/inbox?item=i1");
  const p = pane();
  const fact = await within(p).findByTestId("task-fact");
  expect(fact).toHaveTextContent(/^Done by @?dev · /);
  expect(within(p).getAllByRole("link", { name: "Open task" })[0]).toHaveAttribute(
    "href",
    "/tasks/T-7",
  );
  expect(within(p).queryByRole("textbox")).toBeNull();
});

test("the composer sits below the body's scroller, which scrolls on its own", async () => {
  setup([mention(1, "c4", { kind: "agent", name: "ada" })]);
  await visit("/inbox?item=i1");
  const p = pane();
  const box = await within(p).findByRole("combobox", { name: "Comment" });
  const body = p.querySelector("[data-pane-body]") as HTMLElement;
  const composer = box.closest("[data-pane-composer]") as HTMLElement;
  // jsdom has no layout: this guards the structure (the composer is outside the scroller and after
  // it, both in the pane's flex column); the pinning itself is a browser check.
  expect(body).not.toBeNull();
  expect(body.contains(composer)).toBe(false);
  expect(body.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(body).toHaveClass("overflow-y-auto", "min-h-0", "flex-1");
  expect(composer).toHaveClass("shrink-0");
  expect(body.parentElement).toBe(composer.parentElement);
});

test("switching items shows skeletons, never the previous body", async () => {
  setup([item(1), mention(2, "c4", { kind: "agent", name: "ada" })]);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  api.on("GET /api/tasks/T-7", async () => {
    await held;
    return json(task());
  });
  const app = await visit("/inbox?item=i1");
  await waitFor(() => expect(within(pane()).getByText("preview 1")).toBeInTheDocument());
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  await waitFor(() => expect(pane().querySelector("[data-pane-skeleton]")).not.toBeNull());
  expect(within(pane()).queryByText("preview 1")).toBeNull();
  release();
  await waitFor(() => expect(within(pane()).getByRole("heading", { name: "Seven" })).toBeVisible());
  expect(pane().querySelector("[data-pane-skeleton]")).toBeNull();
  // Two full-app route renders and a held fetch: past the default 5s when the suite runs in parallel.
}, 15_000);

test("a notice shows its text and a link to the session, and has no composer", async () => {
  setup([
    item(1, {
      from: { kind: "factory", name: "factory" },
      about: "dev",
      preview: "Dev hit an error",
    }),
  ]);
  await visit("/inbox?item=i1");
  const p = pane();
  expect(await within(p).findByText("Dev hit an error")).toBeInTheDocument();
  expect(within(p).getByRole("link", { name: "Open in session" })).toHaveAttribute(
    "href",
    "/agents/dev/session?event=42",
  );
  expect(within(p).queryByRole("textbox")).toBeNull();
  expect(within(p).queryByRole("combobox")).toBeNull();
});

test("?item= outside the loaded pages fetches the item and shows it", async () => {
  setup([item(1)]);
  api.on("GET /api/inbox/far", () =>
    json({ item: item(9, { id: "far", from: { kind: "agent", name: "dev" } }) }),
  );
  await visit("/inbox?item=far");
  const p = pane();
  await waitFor(() =>
    expect(within(p).getByRole("link", { name: "Open in session" })).toHaveAttribute(
      "href",
      "/agents/dev/session?event=42",
    ),
  );
  await waitFor(() => expect(within(p).getByText("preview 9")).toBeInTheDocument());
  expect(api.calls.filter((c) => c.url === "/api/inbox/far")).toHaveLength(1);
  // The list's pages don't change.
  expect(document.querySelector('a[data-inbox-id="far"]')).toBeNull();
});

test("an unknown ?item= says it no longer exists", async () => {
  setup([item(1)]);
  api.on("GET /api/inbox/gone", () =>
    json({ error: { code: "inbox_item_not_found", message: "No such inbox item" } }, 404),
  );
  await visit("/inbox?item=gone");
  expect(await within(pane()).findByText("This item no longer exists.")).toBeInTheDocument();
  expect(pane().querySelector("[data-pane-skeleton]")).toBeNull();
});

test("the selected row dropping out of the loaded pages keeps its header", async () => {
  setup([item(1), item(2)]);
  // Its own fetch never answers here: only the kept row can fill the header.
  api.on("GET /api/inbox/i1", () => new Promise<Response>(() => {}));
  const app = await visit("/inbox?item=i1");
  const p = pane();
  await waitFor(() => expect(within(p).getByText("preview 1")).toBeInTheDocument());
  // A refetch drops i1 from the pages (it moved past the loaded window).
  api.on("GET /api/inbox?", () => json({ chats: [], items: [item(2)], nextCursor: null }));
  await app.queryClient.invalidateQueries({ queryKey: ["inbox"] });
  await waitFor(() => expect(document.querySelector('a[data-inbox-id="i1"]')).toBeNull());
  expect(within(p).getByRole("link", { name: "Open in session" })).toBeInTheDocument();
  expect(within(p).getByText("preview 1")).toBeInTheDocument();
  expect(within(p).queryByText("This item no longer exists.")).toBeNull();
  expect(api.calls.filter((c) => c.url === "/api/inbox/i1")).toHaveLength(1);
});

test("a half-typed comment reply survives switching items; a posted one is cleared", async () => {
  setup([mention(1, "c4", { kind: "agent", name: "ada" }), item(2)]);
  api.on(
    "POST /api/tasks/T-7/comments",
    validBody(taskCommentBodySchema, (b) =>
      json(
        {
          comment: {
            type: "comment",
            id: "c9",
            author: { kind: "user", handle: "alice" },
            body: (b as { body: string }).body,
            at: at(9),
          },
          deliveredTo: ["ada"],
          mentionedHumans: [],
          notReached: [],
        },
        201,
      ),
    ),
  );
  const app = await visit("/inbox?item=i1");
  const box = () => within(pane()).getByRole("combobox", { name: "Comment" });
  await waitFor(() => expect(box()).toHaveValue("@ada "));
  await userEvent.type(box(), "half typed");
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  await waitFor(() => expect(within(pane()).getByText("preview 2")).toBeInTheDocument());
  await app.router.navigate({ to: "/inbox", search: { item: "i1" } });
  await waitFor(() => expect(box()).toHaveValue("@ada half typed"));
  fireEvent.click(within(pane()).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(box()).toHaveValue(""));
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  await waitFor(() => expect(within(pane()).getByText("preview 2")).toBeInTheDocument());
  await app.router.navigate({ to: "/inbox", search: { item: "i1" } });
  // Nothing left over: only the prefill comes back.
  await waitFor(() => expect(box()).toHaveValue("@ada "));
}, 20_000);

test("a mention whose comment is gone says so", async () => {
  setup([mention(1, "c-gone", { kind: "agent", name: "ada" })]);
  await visit("/inbox?item=i1");
  expect(await within(pane()).findByText("This comment no longer exists.")).toBeInTheDocument();
  expect(within(pane()).getByRole("heading", { name: "Seven" })).toBeInTheDocument();
});

test("moving on cancels the request for the item passed over", async () => {
  setup([mention(1, "c4", { kind: "agent", name: "ada" }), item(2)]);
  // The task never answers: it is still in flight when the selection moves on.
  api.on("GET /api/tasks/T-7", () => new Promise<Response>(() => {}));
  const app = await visit("/inbox?item=i1");
  const signalOf = (part: string) =>
    (vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes(part))?.[1] as RequestInit)
      ?.signal;
  await waitFor(() => expect(signalOf("/api/tasks/T-7")).toBeDefined());
  expect(signalOf("/api/tasks/T-7")?.aborted).toBe(false);
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  await waitFor(() => expect(within(pane()).getByText("preview 2")).toBeInTheDocument());
  await waitFor(() => expect(signalOf("/api/tasks/T-7")?.aborted).toBe(true));
});

const credential = (name: string, expiresAt: string, current: boolean, o: Over = {}) =>
  item(1, {
    kind: "credential",
    from: { kind: "factory", name: "factory" },
    credential: { name, expiresAt, current },
    link: { kind: "credential", name },
    preview: "stale stored body",
    ...o,
  });

test("a credential item: the live fact, Sign in again opens the sheet, a link to Credentials, no composer", async () => {
  resetSheets();
  setup([credential("personal", "2099-11-12T00:00:00Z", true)]);
  await visit("/inbox?item=i1");
  const p = pane();
  expect(await within(p).findByText(/^personal expires on .*2099\.$/)).toBeInTheDocument();
  expect(within(p).getByRole("link", { name: "Open credentials" })).toHaveAttribute(
    "href",
    "/settings/credentials?credential=personal",
  );
  expect(within(p).queryByRole("textbox")).toBeNull();
  expect(within(p).queryByText("Already signed in again.")).toBeNull();
  await userEvent.click(within(p).getByRole("button", { name: "Sign in again" }));
  expect(getSheetState().parent).toMatchObject({ kind: "sign-in-again", name: "personal" });
  resetSheets();
});

test("a past expiry reads 'expired on'; current false shows Already signed in again.", async () => {
  setup([credential("personal", "2020-11-12T00:00:00Z", false)]);
  await visit("/inbox?item=i1");
  const p = pane();
  expect(await within(p).findByText(/^personal expired on .*2020\.$/)).toBeInTheDocument();
  expect(within(p).getByText("Already signed in again.")).toBeInTheDocument();
  expect(within(p).queryByRole("button", { name: "Sign in again" })).toBeNull();
});
