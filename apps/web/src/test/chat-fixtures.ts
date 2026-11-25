import type { AgentSummary, ChatEntry, ChatPage } from "@open-factory/shared";
import { vi } from "vitest";
import { agentSummary, conversation, detail } from "./session-fixtures";

const at = (i: number) => new Date(Date.UTC(2026, 10, 23, 9, 0, i)).toISOString();
type Message = Extract<ChatEntry, { kind: "message" }>;

/** An agent's reply to alice (the signed-in test user) by default. */
export const chatMsg = (i: number, over: Partial<Message> = {}): Message => ({
  kind: "message",
  id: `m${i}`,
  from: "@dev",
  fromKind: "agent",
  body: `Reply ${i}`,
  recipients: ["@alice"],
  urgent: false,
  createdAt: at(i),
  state: "delivered",
  ...over,
});
/** A message from alice to the dev agent. */
export const mine = (i: number, over: Partial<Message> = {}): Message =>
  chatMsg(i, {
    from: "@alice",
    fromKind: "human",
    body: `Ask ${i}`,
    recipients: ["@dev"],
    ...over,
  });
export const page = (entries: ChatEntry[], over: Partial<ChatPage> = {}): ChatPage => ({
  entries,
  nextCursor: null,
  newerCursor: null,
  working: null,
  ...over,
});

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

type Stub = {
  /** The chat endpoint: the request's url. */
  chat(url: string): ChatPage | Response | Promise<ChatPage | Response>;
  agent?: Partial<AgentSummary>;
  /** Any other /api/agents/dev/... request. */
  other?(url: string, init: RequestInit | undefined): Response | undefined;
};

/** Stubs fetch for the dev agent's chat route; returns every chat url requested. */
export function stubChatApi(stub: Stub) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/agents/dev/chat")) {
        requests.push(url);
        const r = await stub.chat(url);
        return r instanceof Response ? r : json(r);
      }
      const other = stub.other?.(url, init);
      if (other) return other;
      if (url === "/api/agents/dev") return json(detail(stub.agent));
      if (url.startsWith("/api/agents/dev/events")) return json(conversation());
      if (url.startsWith("/api/agents?"))
        return json({
          agents: [agentSummary(stub.agent)],
          more: false,
          running: { count: 0 },
        });
      return json({ error: { code: "not_found" } }, 404);
    }),
  );
  return requests;
}
