import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mockWorld } from "@/test/agent-screens-fixtures";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

const where = (router: ReturnType<typeof renderApp>["router"]) => {
  const l = router.state.location;
  return `${l.pathname}${l.searchStr}${l.hash ? `#${l.hash}` : ""}`;
};

test.each([
  ["/settings", "/settings/credentials"],
  ["/settings#credentials", "/settings/credentials"],
  ["/settings#secrets", "/settings/secrets"],
  ["/settings?addSecret=X#secrets", "/settings/secrets?addSecret=X"],
  ["/settings#projects", "/settings/projects"],
  ["/settings#users", "/settings/users"],
  ["/settings#usage", "/usage"],
  ["/settings?days=7", "/usage?days=7"],
  ["/settings?days=7#usage", "/usage?days=7"],
  ["/settings#factory", "/settings/factory"],
  ["/settings#nonsense", "/settings/credentials"],
  ["/settings?days=bogus", "/settings/credentials"],
])("%s → %s", async (from, to) => {
  mockApi({ "GET /api/agents": () => json({ agents: [], running: { count: 0 } }) });
  const { router } = renderApp(from, alice);
  await waitFor(() => expect(where(router)).toBe(to));
  await waitFor(() => expect(router.state.status).toBe("idle"));
  // A replace: Back must not return to the redirecting URL.
  expect(router.history.canGoBack()).toBe(false);
});

test("in-app links point at the new routes", async () => {
  mockWorld({ credentials: [] });
  renderApp("/settings/projects", alice);
  const link = await screen.findByRole("link", { name: "Credentials" });
  expect(link).toHaveAttribute("href", "/settings/credentials");
});
