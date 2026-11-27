import type { AgentSummary, ChatEntry, ChatPage, PrincipalItem } from "@open-factory/shared";
import { vi } from "vitest";
import { refFor } from "@/test/refs";
import { agentSummary, conversation, detail } from "./session-fixtures";

const at = (i: number) => new Date(Date.UTC(2026, 10, 23, 9, 0, i)).toISOString();
type Message = Extract<ChatEntry, { kind: "message" }>;

/** The dev agent's ref and alice's (the signed-in test user's, see `render-app`). */
export const DEV_REF = refFor("dev");
export const ALICE_REF = refFor("alice");
export const principal = (
  ref: string,
  handle: string,
  kind: "agent" | "human" = "agent",
): PrincipalItem => ({
  id: `id-${ref}`,
  ref,
  kind,
  handle,
  name: handle,
  state: "live",
  avatar: kind === "agent" ? { template: "dev", avatarVersion: null, color: null } : null,
});

/** An agent's reply to alice (the signed-in test user) by default. */
export const chatMsg = (i: number, over: Partial<Message> = {}): Message => ({
  kind: "message",
  id: `m${i}`,
  from: { kind: "agent", ref: DEV_REF },
  body: `Reply ${i}`,
  recipients: [{ ref: ALICE_REF }],
  urgent: false,
  createdAt: at(i),
  state: "delivered",
  ...over,
});
/** A message from alice to the dev agent. */
export const mine = (i: number, over: Partial<Message> = {}): Message =>
  chatMsg(i, {
    from: { kind: "human", ref: ALICE_REF },
    body: `Ask ${i}`,
    recipients: [{ ref: DEV_REF }],
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
  /** Everyone besides the dev agent and alice, whom the principals list always has. */
  principals?: PrincipalItem[];
  /** Any other /api/agents/dev/... request. */
  other?(url: string, init: RequestInit | undefined): Response | undefined;
};

/** Stubs fetch for the dev agent's chat route; returns every chat url requested. */
export function stubChatApi(stub: Stub) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`/api/agents/${refFor("dev")}/chat`)) {
        requests.push(url);
        const r = await stub.chat(url);
        return r instanceof Response ? r : json(r);
      }
      if (url.startsWith("/api/principals"))
        return json({
          principals: [
            principal(DEV_REF, "dev"),
            principal(ALICE_REF, "alice", "human"),
            ...(stub.principals ?? []),
          ],
        });
      const other = stub.other?.(url, init);
      if (other) return other;
      if (url === `/api/agents/${refFor("dev")}`) return json(detail(stub.agent));
      if (url.startsWith(`/api/agents/${refFor("dev")}/events`)) return json(conversation());
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
