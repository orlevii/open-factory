import type { ServerMessage } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { useAgentStatusFrames } from "@/features/session/use-agent-status";
import { WsContext, type WsHub } from "@/lib/ws-context";

function setup() {
  let push: (m: ServerMessage) => void = () => {};
  const hub: WsHub = {
    send: () => true,
    listen: (fn) => {
      push = fn;
      return () => {};
    },
    status: "open",
    openCount: 1,
  };
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <WsContext.Provider value={hub}>{children}</WsContext.Provider>
    </QueryClientProvider>
  );
  renderHook(() => useAgentStatusFrames(), { wrapper });
  return { qc, push: (m: ServerMessage) => act(() => push(m)) };
}

const frame = { type: "agent_status", agent: "dev", status: "idle", turnOpen: false } as const;
const summary = {
  slug: "dev",
  displayName: "Dev",
  status: "working",
  turnOpen: true,
  lastError: "x",
};

test("merges a frame into the list and detail caches, clearing lastError", () => {
  const { qc, push } = setup();
  qc.setQueryData(["agents"], [summary]);
  qc.setQueryData(["agent", "dev"], { agent: summary });
  push(frame);
  expect(qc.getQueryData<(typeof summary)[]>(["agents"])?.[0]).toMatchObject({
    status: "idle",
    turnOpen: false,
    lastError: undefined,
  });
  expect(qc.getQueryData<{ agent: typeof summary }>(["agent", "dev"])?.agent.status).toBe("idle");
});

test("a frame with no cached entry invalidates instead of being lost", () => {
  const { qc, push } = setup();
  const spy = vi.spyOn(qc, "invalidateQueries");
  push(frame);
  expect(spy).toHaveBeenCalledWith({ queryKey: ["agents"] });
  expect(spy).toHaveBeenCalledWith({ queryKey: ["agent", "dev"] });
});
