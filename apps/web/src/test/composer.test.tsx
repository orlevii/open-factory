import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";
import { conversation, detail } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onOpen?: () => void; onStatus?: (s: string) => void }) => {
    setTimeout(() => {
      o.onStatus?.("open");
      o.onOpen?.();
    }, 0);
    return { close() {}, status: () => "open", send: () => true };
  },
}));

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
let posted: { url: string; body: unknown }[];
let postReply: (url: string) => Response;
let agentOver: Parameters<typeof detail>[0];
beforeEach(() => {
  sessionStorage.clear(); // drafts persist per agent
  posted = [];
  agentOver = {};
  postReply = (url) =>
    json(
      {
        item: {
          id: "q",
          kind: url.endsWith("compact") ? "compact" : "message",
          from: "@alice",
          createdAt: "x",
        },
      },
      202,
    );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        return postReply(url);
      }
      if (url === "/api/agents/dev") return json(detail(agentOver));
      if (url.startsWith("/api/agents/dev/events")) return json(conversation());
      return json({}, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const box = () => screen.findByRole("textbox", { name: "Message to Dev agent" });

test("Enter sends, Shift+Enter adds a newline, the box clears on 202", async () => {
  renderApp("/agents/dev", alice);
  const input = await box();
  await userEvent.type(input, "line one{Shift>}{Enter}{/Shift}line two");
  expect(input).toHaveValue("line one\nline two");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(posted).toEqual([
      { url: "/api/agents/dev/messages", body: { body: "line one\nline two", urgent: false } },
    ]),
  );
  await vi.waitFor(() => expect(input).toHaveValue(""));
});

test("Send is disabled for whitespace; Urgent changes the label and hint, then resets", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev", alice);
  const input = await box();
  await userEvent.type(input, "   ");
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
  expect(screen.getByRole("button", { name: "Send urgent" })).toBeInTheDocument();
  expect(screen.getByText("Interrupts the current turn, then runs next.")).toBeInTheDocument();
  await userEvent.type(input, "stop");
  await userEvent.click(screen.getByRole("button", { name: "Send urgent" }));
  await vi.waitFor(() => expect(posted[0]?.body).toEqual({ body: "stop", urgent: true }));
  await vi.waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "Urgent" })).not.toBeChecked(),
  );
});

test("urgent while no turn is open says it sends normally", async () => {
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("checkbox", { name: "Urgent" }));
  expect(screen.getByText("No turn is running, so this sends normally.")).toBeInTheDocument();
});

test("503 clears the box (the message is queued); a 400 keeps the text and shows the error inline", async () => {
  renderApp("/agents/dev", alice);
  const input = await box();
  postReply = () =>
    json(
      {
        error: { code: "agent_start_failed", message: "Set CLAUDE_CODE_OAUTH_TOKEN to run agents" },
      },
      503,
    );
  await userEvent.type(input, "hi{Enter}");
  await vi.waitFor(() => expect(input).toHaveValue(""));
  postReply = () =>
    json({ error: { code: "validation_error", message: "Message is larger than 64 KB" } }, 400);
  await userEvent.type(input, "big{Enter}");
  expect(await screen.findByText("Message is larger than 64 KB")).toBeInTheDocument();
  expect(input).toHaveValue("big");
});

test("slash text is sent as a plain message", async () => {
  renderApp("/agents/dev", alice);
  await userEvent.type(await box(), "/compact{Enter}");
  await vi.waitFor(() =>
    expect(posted[0]).toEqual({
      url: "/api/agents/dev/messages",
      body: { body: "/compact", urgent: false },
    }),
  );
});

test("Compact popover: focus moves to the input; Enter submits with the focus text", async () => {
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("button", { name: "Compact" }));
  const focus = await screen.findByRole("textbox", { name: "Focus (optional)" });
  expect(focus).toHaveFocus();
  await userEvent.type(focus, "keep the API{Enter}");
  await vi.waitFor(() =>
    expect(posted).toEqual([{ url: "/api/agents/dev/compact", body: { focus: "keep the API" } }]),
  );
});

test("Interrupt posts only while a turn is open", async () => {
  agentOver = { status: "working", turnOpen: true };
  renderApp("/agents/dev", alice);
  await box();
  await userEvent.click(screen.getByRole("button", { name: "Interrupt" }));
  await vi.waitFor(() => expect(posted).toEqual([{ url: "/api/agents/dev/interrupt", body: {} }]));
  expect(screen.getByRole("button", { name: "Interrupt" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
