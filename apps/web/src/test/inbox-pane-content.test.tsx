import {
  eventsQuerySchema,
  type ServerMessage,
  type SessionEvent,
  sendMessageBodySchema,
  taskCommentBodySchema,
} from "@open-factory/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { type Handler, json, type MockApi, mockApi, validBody, validQuery } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { detail as agentDetail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
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
  kind: "message",
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
    "GET /api/inbox?": () => json({ items, nextCursor: null }),
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

test("a message shows 7 rows around seq, the target highlighted and scrolled to its start; a reply goes to the sender and marks the item read", async () => {
  setup([item(1)]);
  api.on(
    "POST /api/agents/dev/messages",
    validBody(sendMessageBodySchema, (b) =>
      json(
        {
          item: {
            id: "q1",
            kind: "message",
            body: (b as { body: string }).body,
            from: "@alice",
            createdAt: at(0),
          },
        },
        202,
      ),
    ),
  );
  await visit("/inbox?item=i1");
  const p = pane();
  await waitFor(() => expect(within(p).getByText("dev event 42")).toBeInTheDocument());
  for (let s = 39; s <= 45; s++) expect(within(p).getByText(`dev event ${s}`)).toBeInTheDocument();
  const lit = p.querySelectorAll("[data-highlighted]");
  expect(lit).toHaveLength(1);
  expect(lit[0]).toHaveTextContent("dev event 42");
  await waitFor(() =>
    expect(
      vi
        .mocked(Element.prototype.scrollIntoView)
        .mock.contexts.some((el) => el === lit[0] || (el as Element).contains?.(lit[0] as Node)),
    ).toBe(true),
  );
  expect(vi.mocked(Element.prototype.scrollIntoView)).toHaveBeenCalledWith({ block: "start" });
  // Excerpt rows are plain TimelineRows: no copy links.
  expect(within(p).queryByRole("button", { name: /copy link/i })).toBeNull();

  // A deep link doesn't mark the item read; replying does.
  expect(reads()).toHaveLength(0);
  const box = await within(p).findByRole("textbox", { name: "Message to Dev agent" });
  await userEvent.type(box, "On it");
  fireEvent.click(within(p).getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(
      api.calls.find((c) => c.method === "POST" && c.url === "/api/agents/dev/messages")?.body,
    ).toEqual({ body: "On it", urgent: false }),
  );
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i1/read"]));
  expect(within(p).getByRole("checkbox", { name: "Urgent" })).toBeInTheDocument();
});

test("without seq the excerpt is the latest 7 events, with no highlight", async () => {
  setup([item(1, { link: { kind: "session", agentSlug: "dev" } })]);
  await visit("/inbox?item=i1");
  const p = pane();
  await waitFor(() => expect(within(p).getByText("dev event 100")).toBeInTheDocument());
  for (let s = 94; s <= 100; s++) expect(within(p).getByText(`dev event ${s}`)).toBeInTheDocument();
  expect(p.querySelector("[data-highlighted]")).toBeNull();
  expect(
    api.calls.filter((c) => c.url.startsWith("/api/agents/dev/events")).map((c) => c.url),
  ).toEqual(["/api/agents/dev/events?limit=7"]);
});

test("a @factory message targets the subject agent", async () => {
  setup([
    item(1, {
      from: { kind: "factory", name: "factory" },
      about: "ops",
      link: { kind: "session", agentSlug: "ops" },
    }),
  ]);
  api.on("GET /api/agents/ops", () => json(agentDetail({ slug: "ops", displayName: "Ops" })));
  api.on("GET /api/agents/ops/events?", validQuery(eventsQuerySchema, eventsRoute("ops")));
  api.on(
    "POST /api/agents/ops/messages",
    validBody(sendMessageBodySchema, () =>
      json({ item: { id: "q1", kind: "message", from: "@alice", createdAt: at(0) } }, 202),
    ),
  );
  await visit("/inbox?item=i1");
  const p = pane();
  await waitFor(() => expect(within(p).getByText("ops event 100")).toBeInTheDocument());
  const box = await within(p).findByRole("textbox", { name: "Message to Ops" });
  await userEvent.type(box, "Restarting you");
  fireEvent.click(within(p).getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(api.calls.some((c) => c.method === "POST" && c.url === "/api/agents/ops/messages")).toBe(
      true,
    ),
  );
  expect(api.calls.some((c) => c.url.startsWith("/api/agents/dev"))).toBe(false);
});

test("a terminated sender shows the read-only line; an archived one the archived line", async () => {
  setup([
    item(1),
    item(2, {
      from: { kind: "agent", name: "old" },
      link: { kind: "session", agentSlug: "old", seq: 42 },
    }),
  ]);
  api.on("GET /api/agents/dev", () => json(agentDetail({ status: "terminated" })));
  api.on("GET /api/agents/old", () =>
    json(agentDetail({ slug: "old", displayName: "Old", archivedAt: at(0) })),
  );
  api.on("GET /api/agents/old/events?", validQuery(eventsQuerySchema, eventsRoute("old")));
  const app = await visit("/inbox?item=i1");
  expect(
    await within(pane()).findByText("This agent was terminated. Its session is read-only."),
  ).toBeInTheDocument();
  expect(within(pane()).queryByRole("textbox")).toBeNull();
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  expect(await within(pane()).findByText(/This agent is archived\./)).toBeInTheDocument();
  expect(within(pane()).queryByRole("textbox")).toBeNull();
});

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
  const box = within(p).getByRole("textbox", { name: "Comment" });
  await waitFor(() => expect(box).toHaveValue("@ada "));
  expect(reads()).toHaveLength(0);
  await userEvent.type(box, "thanks");
  fireEvent.click(within(p).getByRole("button", { name: "Comment" }));
  await waitFor(() =>
    expect(api.calls.find((c) => c.url === "/api/tasks/T-7/comments")?.body).toEqual({
      body: "@ada thanks",
    }),
  );
  await waitFor(() => expect(reads().map((c) => c.url)).toEqual(["/api/inbox/i1/read"]));
});

test("a mention by a human leaves the composer empty", async () => {
  setup([mention(1, "h1", { kind: "human", name: "bob" })]);
  await visit("/inbox?item=i1");
  const p = pane();
  await waitFor(() => expect(within(p).getByText("comment h1")).toBeInTheDocument());
  expect(within(p).getByRole("textbox", { name: "Comment" })).toHaveValue("");
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
  setup([item(1)]);
  await visit("/inbox?item=i1");
  const p = pane();
  const box = await within(p).findByRole("textbox", { name: "Message to Dev agent" });
  const body = p.querySelector("[data-pane-body]") as HTMLElement;
  const composer = box.closest("form") as HTMLElement;
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
  setup([item(1), item(2, { link: { kind: "session", agentSlug: "dev", seq: 60 } })]);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  api.on("GET /api/agents/dev/events?around=60", async (b, u) => {
    await held;
    return eventsRoute("dev")(b, u);
  });
  const app = await visit("/inbox?item=i1");
  await waitFor(() => expect(within(pane()).getByText("dev event 42")).toBeInTheDocument());
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  await waitFor(() => expect(pane().querySelector("[data-pane-skeleton]")).not.toBeNull());
  expect(within(pane()).queryByText("dev event 42")).toBeNull();
  release();
  await waitFor(() => expect(within(pane()).getByText("dev event 60")).toBeInTheDocument());
  expect(pane().querySelector("[data-pane-skeleton]")).toBeNull();
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
      "/agents/dev?event=42",
    ),
  );
  await waitFor(() => expect(within(p).getByText("dev event 42")).toBeInTheDocument());
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
  await waitFor(() => expect(within(p).getByText("dev event 42")).toBeInTheDocument());
  // A refetch drops i1 from the pages (it moved past the loaded window).
  api.on("GET /api/inbox?", () => json({ items: [item(2)], nextCursor: null }));
  await app.queryClient.invalidateQueries({ queryKey: ["inbox"] });
  await waitFor(() => expect(document.querySelector('a[data-inbox-id="i1"]')).toBeNull());
  expect(within(p).getByRole("link", { name: "Open in session" })).toBeInTheDocument();
  expect(within(p).getByText("dev event 42")).toBeInTheDocument();
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
  const box = () => within(pane()).getByRole("textbox", { name: "Comment" });
  await waitFor(() => expect(box()).toHaveValue("@ada "));
  await userEvent.type(box(), "half typed");
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  await waitFor(() => expect(within(pane()).getByText("dev event 42")).toBeInTheDocument());
  await app.router.navigate({ to: "/inbox", search: { item: "i1" } });
  await waitFor(() => expect(box()).toHaveValue("@ada half typed"));
  fireEvent.click(within(pane()).getByRole("button", { name: "Comment" }));
  await waitFor(() => expect(box()).toHaveValue(""));
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  await waitFor(() => expect(within(pane()).getByText("dev event 42")).toBeInTheDocument());
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
  setup([item(1), item(2, { link: { kind: "session", agentSlug: "dev", seq: 60 } })]);
  // i1's excerpt never answers: it is still in flight when the selection moves on.
  api.on("GET /api/agents/dev/events?around=42&limit=7", () => new Promise<Response>(() => {}));
  const app = await visit("/inbox?item=i1");
  const signalOf = (part: string) =>
    (vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes(part))?.[1] as RequestInit)
      ?.signal;
  await waitFor(() => expect(signalOf("around=42")).toBeDefined());
  expect(signalOf("around=42")?.aborted).toBe(false);
  await app.router.navigate({ to: "/inbox", search: { item: "i2" } });
  await waitFor(() => expect(within(pane()).getByText("dev event 60")).toBeInTheDocument());
  await waitFor(() => expect(signalOf("around=42")?.aborted).toBe(true));
});
