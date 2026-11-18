import { act, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";

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
        agents: [
          {
            slug: "dev",
            displayName: "Dev agent",
            description: "",
            status: "working",
            turnOpen: true,
            runtime: "local",
          },
        ],
      }),
    ),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(row).toHaveAttribute("href", "/agents/dev");
  expect(within(row).getByText("Working")).toBeInTheDocument();
  expect(within(row).getByText("dev")).toBeInTheDocument();
  expect(within(row).getByText("Unsandboxed")).toBeInTheDocument();
});

test("empty list names the seed command", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ agents: [] })),
  );
  renderApp("/agents", alice);
  expect(await screen.findByText(/No agents yet\. Run/)).toBeInTheDocument();
  expect(screen.getByText("pnpm seed:dev-agent")).toBeInTheDocument();
});

test("a pushed agent_status frame turns the row's Working into Idle", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        agents: [
          {
            slug: "dev",
            displayName: "Dev agent",
            description: "",
            status: "working",
            turnOpen: true,
            runtime: "local",
          },
        ],
      }),
    ),
  );
  renderApp("/agents", alice);
  const row = await screen.findByRole("link", { name: /Dev agent/ });
  expect(within(row).getByText("Working")).toBeInTheDocument();
  act(() => pushFrame({ type: "agent_status", agent: "dev", status: "idle", turnOpen: false }));
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
