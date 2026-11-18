import { screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
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
