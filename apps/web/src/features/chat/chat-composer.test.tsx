import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { chatMsg, DEV_REF, json, mine, page, principal, stubChatApi } from "@/test/chat-fixtures";
import { installFakeXhr } from "@/test/fake-xhr";
import { refFor } from "@/test/refs";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";
import { onChatChanged } from "./use-chat";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onStatus?: (s: string) => void; onOpen?: () => void }) => {
    setTimeout(() => {
      o.onStatus?.("open");
      o.onOpen?.();
    }, 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[];
let results: (body: Record<string, unknown>) => unknown;
let thread: ReturnType<typeof chatMsg>[];
let working: { key: string; since: string } | null;
let agent: Partial<Parameters<typeof agentSummary>[0]>;
let commands: unknown;
let extraAgents: ReturnType<typeof agentSummary>[];

/** The server names a recipient as a mention, `<@ref|handle>`; the ref here is a stand-in per handle. */
/** The handle a ref in a sent `to` belongs to (the refs here are `refFor` of the handles the tests use). */
const HANDLE_OF: Record<string, string> = Object.fromEntries(
  ["dev", "ops", "qa"].map((h) => [refFor(h), h]),
);
/** The server names a recipient as a mention; takes a handle or the ref a send carried. */
const mentioned = (who: string) => {
  const handle = HANDLE_OF[who] ?? who;
  return `<@${refFor(handle)}|${handle}>`;
};
const queued = (to: string) => ({ to: mentioned(to), status: "queued", id: `row-${to}` });
const OPS = agentSummary({ handle: "ops", displayName: "Ops agent", template: "ops" });
const QA = agentSummary({ handle: "qa", displayName: "QA agent", template: "qa" });

beforeEach(() => {
  localStorage.clear();
  sent = [];
  thread = [mine(1), chatMsg(2)];
  working = null;
  agent = {};
  commands = undefined;
  extraAgents = [];
  results = (b) => ({ results: (b.to as string[]).map(queued) });
  stubChatApi({
    chat: () => page(thread, { working }),
    get agent() {
      return agent;
    },
    get principals() {
      return [OPS, QA, ...extraAgents].map((a) => principal(a.ref, a.handle));
    },
    other(url, init) {
      if (url === "/api/messages" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        sent.push({ url, body });
        return json(results(body), 202);
      }
      if (url.endsWith("/interrupt")) {
        sent.push({ url, body: {} });
        return json({});
      }
      if (url.startsWith("/api/agents?"))
        return json({
          agents: [agentSummary(agent), OPS, QA, ...extraAgents],
          more: false,
          running: { count: 0 },
        });
      if (url === `/api/agents/${refFor("dev")}/commands` && commands) return json(commands);
      return undefined;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const box = () => screen.findByRole("combobox", { name: "Message to Dev agent" });
const note = () => document.querySelector<HTMLElement>("[data-composer-hint]");
const toRow = () => document.querySelector<HTMLElement>("[data-recipients]");
/** Adds an agent through the "Add recipient" picker, then closes it. */
async function addRecipient(handle: string) {
  await userEvent.click(await screen.findByRole("button", { name: "Add recipient" }));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(`@${handle}$`) }));
  await userEvent.keyboard("{Escape}");
  return box();
}

test("no 'To:' row with one recipient; the toolbar has @ and attach, no /", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await box();
  expect(toRow()).toBeNull();
  expect(screen.getByRole("button", { name: "Add recipient" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Mention someone" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Attach files" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /command/i })).toBeNull();
  expect(await box()).toHaveAttribute("placeholder", "Message Dev agent");
});

test("picking from @ in chat inserts a mention and adds no recipient", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await box();
  await userEvent.type(input, "hello @op");
  const menu = await screen.findByRole("listbox", { name: "Mention someone" });
  expect(screen.getByText("A mention doesn't send · Esc keeps it as text")).toBeInTheDocument();
  await userEvent.click(within(menu).getByRole("option", { name: /ops/ }));
  expect(toRow()).toBeNull();
  await userEvent.type(input, "go{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.body).toMatchObject({
    to: [refFor("dev")],
    body: `hello <@${refFor("ops")}> go`,
  });
});

test("Add recipient adds an agent and announces it", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await box();
  await userEvent.click(screen.getByRole("button", { name: "Add recipient" }));
  const menu = await screen.findByRole("listbox");
  // The chat's own agent is not offered; the others are, and the footer says who gets messages.
  expect(within(menu).queryByRole("option", { name: /@dev$/ })).toBeNull();
  expect(
    screen.getByText("Only live agents get messages · Up to 10 per message"),
  ).toBeInTheDocument();
  await userEvent.click(within(menu).getByRole("option", { name: /@ops$/ }));
  expect(screen.getByRole("listbox")).toBeInTheDocument(); // stays open for the next pick
  expect(screen.getByRole("option", { name: /@ops.*Added/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(toRow()).toHaveTextContent("To: Dev agent");
  expect(within(toRow() as HTMLElement).getByRole("button", { name: "Remove @ops" })).toBeVisible();
  expect(screen.getByText("Also sending to @ops")).toBeInTheDocument();
  expect(await box()).toHaveAttribute("placeholder", "Message Dev agent and 1 other");
  // Reopened, an added agent is left out.
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getAllByRole("button", { name: "Add" })[0] as HTMLElement);
  expect(
    within(await screen.findByRole("listbox")).queryByRole("option", { name: /@ops$/ }),
  ).toBeNull();
});

test("Add recipient offers only live agents", async () => {
  extraAgents = [agentSummary({ handle: "gone", displayName: "Gone", template: "ops" })];
  const gone = principal(refFor("gone"), "gone");
  const base = fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
  vi.stubGlobal("fetch", async (u: string, i?: RequestInit) => {
    if (u.startsWith("/api/principals")) {
      const body = (await (await base(u, i)).json()) as { principals: unknown[] };
      return json({ ...body, principals: [...body.principals, { ...gone, state: "terminated" }] });
    }
    return base(u, i);
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await box();
  await userEvent.click(screen.getByRole("button", { name: "Add recipient" }));
  const menu = await screen.findByRole("listbox");
  expect(within(menu).getByRole("option", { name: /@ops$/ })).toBeInTheDocument();
  expect(within(menu).queryByRole("option", { name: /@gone$/ })).toBeNull();
});

test("Esc keeps a typed @name as text", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await box();
  await userEvent.type(input, "@ops");
  await screen.findByRole("listbox");
  await userEvent.keyboard("{Escape}");
  expect(input).toHaveValue("@ops");
  expect(toRow()).toBeNull();
});

test("Backspace in an empty box selects the last chip, then removes it", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await addRecipient("ops");
  const input = await box();
  await userEvent.clear(input);
  await userEvent.keyboard("{Backspace}");
  expect(document.querySelector(`[data-recipient="${refFor("ops")}"]`)).toHaveAttribute(
    "data-selected",
  );
  await userEvent.keyboard("{Backspace}");
  expect(toRow()).toBeNull();
  expect(screen.getByText("Removed @ops")).toBeInTheDocument();
});

test("typing clears the chip's selection", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await addRecipient("ops");
  await userEvent.click(input);
  await userEvent.keyboard("{Backspace}");
  expect(document.querySelector(`[data-recipient="${refFor("ops")}"]`)).toHaveAttribute(
    "data-selected",
  );
  await userEvent.type(input, "x");
  expect(document.querySelector(`[data-recipient="${refFor("ops")}"]`)).not.toHaveAttribute(
    "data-selected",
  );
  await userEvent.keyboard("{Backspace}{Backspace}");
  expect(toRow()).not.toBeNull();
});

test("recipients survive a remount from the draft; the key goes only when text and recipients both do", async () => {
  const first = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await addRecipient("ops");
  expect(
    JSON.parse(localStorage.getItem(`of-draft:v1:chat:${refFor("dev")}`) as string),
  ).toMatchObject({
    recipients: [refFor("ops")],
  });
  first.unmount();
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await waitFor(() => expect(toRow()).toHaveTextContent("To: Dev agent"));
  expect(document.querySelector(`[data-recipient="${refFor("ops")}"]`)).not.toBeNull();
  const input = await box();
  await userEvent.type(input, "hi");
  fireEvent.blur(input);
  expect(
    JSON.parse(localStorage.getItem(`of-draft:v1:chat:${refFor("dev")}`) as string),
  ).toMatchObject({
    text: "hi",
    recipients: [refFor("ops")],
  });
  await userEvent.click(screen.getByRole("button", { name: "Remove @ops" }));
  expect(
    JSON.parse(localStorage.getItem(`of-draft:v1:chat:${refFor("dev")}`) as string),
  ).toMatchObject({
    text: "hi",
  });
  await userEvent.clear(input);
  fireEvent.blur(input);
  expect(localStorage.getItem(`of-draft:v1:chat:${refFor("dev")}`)).toBeNull();
});

test("with two recipients the paperclip is aria-disabled and says why on the note slot", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await addRecipient("ops");
  const clip = screen.getByRole("button", { name: "Attach files" });
  expect(clip).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(clip);
  expect(note()).toHaveTextContent("Files go to one agent at a time");
  // Removing the recipient frees it, and the note goes with its cause.
  await userEvent.click(screen.getByRole("button", { name: "Remove @ops" }));
  expect(clip).not.toHaveAttribute("aria-disabled");
  expect(note()).not.toHaveTextContent("Files go to one agent at a time");
});

test("a leading /command shows where commands run; Open session carries the text", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await box();
  await userEvent.type(input, "/context");
  expect(note()).toHaveTextContent("Commands run in the session · Open session");
  await userEvent.click(within(note() as HTMLElement).getByRole("link", { name: "Open session" }));
  expect(
    JSON.parse(localStorage.getItem(`of-draft:v1:session:${refFor("dev")}`) as string).text,
  ).toBe("/context");
});

test("a /context message is sent as message text, to the chat's agent", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await userEvent.type(await box(), "/context{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.body).toMatchObject({ to: [refFor("dev")], body: "/context", urgent: false });
});

test("Stop shows only while the turn that read your message runs; Esc stops it", async () => {
  working = { key: "m1", since: new Date().toISOString() };
  agent = { status: "working", turnOpen: true };
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await box();
  const stop = await screen.findByRole("button", { name: "Stop" });
  expect(stop).toBeInTheDocument();
  await userEvent.click(input);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(sent.some((s) => s.url.endsWith("/interrupt"))).toBe(true));
});

test("no Stop when a turn is open but didn't read your message", async () => {
  agent = { status: "working", turnOpen: true };
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await box();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("Alt+Enter sends urgent", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await userEvent.type(await box(), "now{Alt>}{Enter}{/Alt}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.body).toMatchObject({ body: "now", urgent: true });
});

test("a send to two agents posts both, the chat's agent first", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await addRecipient("ops");
  await userEvent.type(input, "both{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.body).toMatchObject({ to: [refFor("dev"), refFor("ops")], body: "both" });
  expect(sent[0]?.body.clientMessageId).toEqual(expect.any(String));
});

test("a refused extra recipient is named; the rest are sent", async () => {
  results = (b) => ({
    results: (b.to as string[]).map((t) =>
      HANDLE_OF[t] === "ops"
        ? {
            to: mentioned("ops"),
            status: "refused",
            code: "terminated",
            reason: "@ops was terminated and can't receive messages.",
          }
        : queued(t),
    ),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await addRecipient("ops");
  await userEvent.type(input, "hello{Enter}");
  await waitFor(() => expect(note()).toHaveTextContent("Not sent to @ops: terminated."));
  expect(input).toHaveValue("");
});

test("each refused recipient gets its own line", async () => {
  results = (b) => ({
    results: (b.to as string[]).map((t) =>
      HANDLE_OF[t] === "dev"
        ? queued(t)
        : {
            to: mentioned(t),
            status: "refused",
            code: HANDLE_OF[t] === "ops" ? "terminated" : "archived",
            reason: "x",
          },
    ),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await addRecipient("ops");
  await addRecipient("qa");
  await userEvent.type(await box(), "hi{Enter}");
  await waitFor(() =>
    expect(note()).toHaveTextContent("Not sent to @ops: terminated. Not sent to @qa: archived."),
  );
});

test("when the chat's agent is refused the draft stays, with the reason and who it did reach", async () => {
  results = (b) => ({
    results: (b.to as string[]).map((t) =>
      HANDLE_OF[t] === "dev"
        ? {
            to: mentioned("dev"),
            status: "refused",
            code: "archived",
            reason: "@dev is archived and can't receive messages.",
          }
        : queued(t),
    ),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await addRecipient("ops");
  await userEvent.type(input, "hello{Enter}");
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "@dev is archived and can't receive messages. Sent to @ops only.",
  );
  expect(input).toHaveValue("hello");
  // Its optimistic block went with the failure.
  expect(
    within(document.querySelector("[role=log]") as HTMLElement).queryByText("hello"),
  ).toBeNull();
});

test("your send is one node: the optimistic block and the server's row are the same element, never live", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const base = results;
  results = (b) => base(b);
  const { queryClient } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Reply 2");
  // Hold the POST so the optimistic block shows first.
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/messages") await gate;
    return real(url, init);
  });
  await userEvent.type(await box(), "hello there{Enter}");
  const body = await screen.findByText("hello there");
  const optimistic = body.closest("[data-row-wrap]") as HTMLElement;
  // The block's key is the clientMessageId the POST carries.
  const id = optimistic.querySelector("[data-row]")?.getAttribute("data-row") as string;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(optimistic.querySelector("[data-row]")).toHaveAccessibleDescription("Sending…");
  expect(screen.getAllByText("hello there")).toHaveLength(1);
  // The server's row, same clientMessageId, arrives through the chat query.
  thread = [
    ...thread,
    mine(3, {
      body: "hello there",
      clientMessageId: id,
      recipients: [{ ref: DEV_REF }],
      state: "delivered",
    }),
  ];
  release();
  act(() => onChatChanged(queryClient, { type: "chat_changed", agent: refFor("dev") }));
  await waitFor(() => expect(sent).toHaveLength(1));
  await waitFor(() => expect(document.querySelector(`[data-row="${id}"]`)).not.toBeNull());
  expect(screen.getAllByText("hello there")).toHaveLength(1);
  expect(body.closest("[data-row-wrap]")).toBe(optimistic);
  expect(optimistic).not.toHaveAttribute("data-live");
  expect(optimistic.querySelector("[data-row]")).not.toHaveAccessibleDescription("Sending…");
  expect(sent[0]?.body.clientMessageId).toBe(id);
});

test("↑ in an empty box recalls your newest message", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Ask 1");
  const input = await box();
  await userEvent.click(input);
  await userEvent.keyboard("{ArrowUp}");
  expect(input).toHaveValue("Ask 1");
});

test("a failed send takes its block out of the thread and puts the text back", async () => {
  results = () => ({
    error: { code: "validation_error", message: "Message is larger than 64 KB" },
  });
  const real = globalThis.fetch;
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Reply 2");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
    url === "/api/messages"
      ? json({ error: { code: "validation_error", message: "Too big" } }, 400)
      : real(url, init),
  );
  const input = await box();
  await userEvent.type(input, "lost{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("Too big");
  expect(input).toHaveValue("lost");
  const log = document.querySelector("[role=log]") as HTMLElement;
  expect(within(log).queryByText("lost")).toBeNull();
});

const paste = (input: HTMLElement, files: File[]) =>
  fireEvent.paste(input, {
    clipboardData: { files, getData: () => "", types: ["Files"] },
  });

test("Add recipient is aria-disabled while files are attached; pressing says why until you type or the file goes", async () => {
  installFakeXhr();
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await box();
  paste(input, [new File(["x"], "notes.txt", { type: "text/plain" })]);
  const add = screen.getByRole("button", { name: "Add recipient" });
  await waitFor(() => expect(add).toHaveAttribute("aria-disabled", "true"));
  await userEvent.click(add);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(note()).toHaveTextContent("Files go to one agent at a time");
  expect(toRow()).toBeNull();
  await userEvent.type(input, "x");
  expect(note()).not.toHaveTextContent("Files go to one agent at a time");
  // The same note goes when the file does, and adding works again.
  await userEvent.click(add);
  expect(note()).toHaveTextContent("Files go to one agent at a time");
  await userEvent.click(screen.getByRole("button", { name: /^(Cancel|Remove) notes.txt$/ }));
  expect(note()).not.toHaveTextContent("Files go to one agent at a time");
  expect(add).not.toHaveAttribute("aria-disabled");
});

test("'Not sent to @x' goes when you type the next message", async () => {
  results = (b) => ({
    results: (b.to as string[]).map((t) =>
      HANDLE_OF[t] === "ops"
        ? { to: mentioned("ops"), status: "refused", code: "terminated", reason: "x" }
        : queued(t),
    ),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await addRecipient("ops");
  await userEvent.type(input, "hello{Enter}");
  await waitFor(() => expect(note()).toHaveTextContent("Not sent to @ops: terminated."));
  await userEvent.type(input, "next");
  expect(note()).not.toHaveTextContent("Not sent to @ops");
});

test("the touch hint points at Stop only where Stop shows", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q === "(pointer: coarse)",
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
  agent = { status: "working", turnOpen: true };
  const first = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await box();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(document.body).not.toHaveTextContent("Stop first to interrupt");
  first.unmount();
  working = { key: "m1", since: new Date().toISOString() };
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByRole("button", { name: "Stop" });
  await waitFor(() => expect(document.body).toHaveTextContent("Stop first to interrupt"));
});

test("Add recipient is aria-disabled with its reason at 10 recipients; a message still goes to all ten", async () => {
  extraAgents = Array.from({ length: 7 }, (_, i) =>
    agentSummary({ handle: `a${i}`, displayName: `Agent ${i}`, template: "ops" }),
  );
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await addRecipient("ops");
  await addRecipient("qa");
  for (let i = 0; i < 7; i++) await addRecipient(`a${i}`);
  expect(document.querySelectorAll("[data-recipient]")).toHaveLength(9);
  const add = screen.getByRole("button", { name: "Add recipient" });
  expect(add).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(add);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(note()).toHaveTextContent("A message goes to at most 10 agents.");
  await userEvent.type(await box(), "all{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]?.body.to).toHaveLength(10);
});

test("your message shows at once, from you and also to the agents you added, while the send is out", async () => {
  let release: (r: Response) => void = () => {};
  const base = fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>;
  vi.stubGlobal("fetch", (u: string, i?: RequestInit) =>
    u === "/api/messages"
      ? new Promise<Response>((r) => {
          release = r;
        })
      : base(u, i),
  );
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await addRecipient("ops");
  await userEvent.type(input, "hi{Enter}");
  const group = await screen.findByRole("group", { name: "Also to @ops" });
  expect(group.closest("[data-row]")).toHaveTextContent("You");
  expect(document.body).not.toHaveTextContent("@unknown");
  release(json({ results: [] }, 202));
});

test("the first Backspace announces the selected chip; leaving the box clears it", async () => {
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await addRecipient("ops");
  await userEvent.clear(input);
  await userEvent.keyboard("{Backspace}");
  expect(screen.getByText("@ops selected. Backspace again to remove")).toBeInTheDocument();
  fireEvent.blur(input);
  expect(document.querySelector(`[data-recipient="${refFor("ops")}"]`)).not.toHaveAttribute(
    "data-selected",
  );
});

test("stored recipients: the chat's own agent and duplicates are dropped; ten or more, or a non-string list, are not kept", async () => {
  localStorage.setItem(
    `of-draft:v1:chat:${refFor("dev")}`,
    JSON.stringify({
      text: "",
      at: Date.now(),
      recipients: [refFor("dev"), refFor("ops"), refFor("ops")],
    }),
  );
  const first = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await box();
  expect(document.querySelectorAll("[data-recipient]")).toHaveLength(1);
  first.unmount();
  localStorage.setItem(
    `of-draft:v1:chat:${refFor("dev")}`,
    JSON.stringify({
      text: "hi",
      at: Date.now(),
      recipients: Array.from({ length: 10 }, (_, i) => `x${i}`),
    }),
  );
  const second = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(await box()).toHaveValue("hi");
  expect(toRow()).toBeNull();
  second.unmount();
  // Not a string[]: dropped, the text stays.
  localStorage.setItem(
    `of-draft:v1:chat:${refFor("dev")}`,
    JSON.stringify({ text: "hi", at: Date.now(), recipients: [1, 2] }),
  );
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  expect(await box()).toHaveValue("hi");
  expect(toRow()).toBeNull();
});

test("a leading /word is a note only for a command the loaded list knows", async () => {
  commands = {
    commands: [{ name: "context", description: "", argumentHint: "", builtin: true }],
    source: "session",
    at: null,
    stale: false,
  };
  const { queryClient } = renderApp(`/agents/${refFor("dev")}/chat`, alice);
  const input = await box();
  // The chat itself loads the list: nothing else has to have.
  await waitFor(() =>
    expect(queryClient.getQueryData(["agent-commands", refFor("dev")])).toBeDefined(),
  );
  await userEvent.type(input, "/nope");
  expect(note()).not.toHaveTextContent("Commands run in the session");
  await userEvent.clear(input);
  await userEvent.type(input, "/context");
  expect(note()).toHaveTextContent("Commands run in the session");
});

test("a send the server could not start keeps its block, pending", async () => {
  results = (b) => ({
    results: (b.to as string[]).map((t) => ({
      to: mentioned(t),
      status: "start_failed",
      id: "r1",
    })),
  });
  renderApp(`/agents/${refFor("dev")}/chat`, alice);
  await screen.findByText("Reply 2");
  await userEvent.type(await box(), "queued{Enter}");
  await waitFor(() => expect(sent).toHaveLength(1));
  const block = (await screen.findByText("queued")).closest("[data-row]");
  expect(block).toHaveAccessibleDescription("Sending…");
});

test("sending from a ?message= window goes back to the newest messages", async () => {
  const { router } = renderApp(`/agents/${refFor("dev")}/chat?message=m1`, alice);
  await screen.findByText("Ask 1");
  await userEvent.type(await box(), "hello{Enter}");
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  await waitFor(() => expect(sent).toHaveLength(1));
});
