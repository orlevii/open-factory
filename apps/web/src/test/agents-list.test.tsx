import { act, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { mockWorld } from "@/test/agent-screens-fixtures";
import { alice, renderApp } from "@/test/render-app";
import { agentSummary } from "@/test/session-fixtures";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
let pushFrame: (m: unknown) => void = () => {};
vi.mock("@/lib/ws", () => ({
  connectWs: (o: { onMessage?: (m: unknown) => void }) => {
    pushFrame = (m) => o.onMessage?.(m);
    return { close() {}, status: () => "open", send: () => true };
  },
}));
afterEach(() => vi.unstubAllGlobals());

const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("lists agents with status label, slug and the unsandboxed badge", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [agentSummary({ status: "working", turnOpen: true, template: "developer" })],
      }),
    ),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(row).toHaveAttribute("href", "/agents/dev");
  expect(within(row).getByText("Working")).toBeInTheDocument();
  expect(within(row).getByText("dev")).toBeInTheDocument();
  expect(within(row).getByText("developer")).toBeInTheDocument();
  expect(within(row).getByText("Unsandboxed")).toBeInTheDocument();
});

test("an empty list points at creating an agent from a template", async () => {
  mockWorld({ agents: [] });
  renderApp("/agents", alice);
  expect(await screen.findByText(/No agents yet\./)).toHaveTextContent(
    "No agents yet. Create one from a template.",
  );
  expect(screen.queryByText(/seed:dev-agent/)).not.toBeInTheDocument();
});

test("a pushed agent_status frame turns the row's Working into Idle", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [agentSummary({ status: "working", turnOpen: true })],
      }),
    ),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(within(row).getByText("Working")).toBeInTheDocument();
  act(() =>
    pushFrame({
      type: "agent_status",
      agent: "dev",
      status: "idle",
      turnOpen: false,
      restartPending: false,
      restartWaitingOn: 0,
    }),
  );
  expect(await within(row).findByText("Idle")).toBeInTheDocument();
  expect(within(row).queryByText("Working")).not.toBeInTheDocument();
});

test("a failed list says so", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 500 })),
  );
  renderApp("/agents", alice);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load agents.");
});
