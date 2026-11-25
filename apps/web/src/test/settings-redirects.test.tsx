import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mockWorld } from "@/test/agent-screens-fixtures";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

test("bare /settings lands on the first section without a history entry", async () => {
  mockApi({ "GET /api/agents": () => json({ agents: [], running: { count: 0 } }) });
  const { router } = renderApp("/settings", alice);
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings/credentials"));
  await waitFor(() => expect(router.state.status).toBe("idle"));
  expect(router.history.canGoBack()).toBe(false);
});

test("in-app links point at the new routes", async () => {
  mockWorld({ credentials: [] });
  renderApp("/settings/projects", alice);
  const link = await screen.findByRole("link", { name: "Credentials" });
  expect(link).toHaveAttribute("href", "/settings/credentials");
});
