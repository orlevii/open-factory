import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { afterEach, expect } from "vitest";
import { clearViewPositions } from "@/features/agents/view-memory";
import { createQueryClient } from "@/lib/query-client";
import { type Session, sessionQueryOptions } from "@/lib/session";
import { createAppRouter } from "@/router";
import { refFor } from "@/test/refs";

type AppRouter = ReturnType<typeof createAppRouter>;
const rendered = new Set<AppRouter>();

// A test can end on an assertion made while a navigation is still loading (the location changes when
// it starts; the route chunk and loaders come after). Left running, it commits after this file's
// jsdom is torn down and React throws "window is not defined" as an unhandled rejection, which fails
// the run. So each test's navigations settle before cleanup unmounts it (after-hooks run in reverse,
// so this runs before the setup file's cleanup).
afterEach(async () => {
  const routers = [...rendered];
  rendered.clear();
  await waitFor(() => {
    for (const router of routers) expect(router.state.status).toBe("idle");
  });
});

export const alice: Session = {
  user: {
    id: "u1",
    name: "Alice",
    handle: "alice",
    email: "alice@example.com",
    ref: refFor("alice"),
  },
};

/** Renders the real route tree at `path` with the session query pre-seeded. `undefined` leaves the
 *  query empty, so the guard really asks `/api/me` (mock the API). */
export function renderApp(path: string, session: Session | null | undefined) {
  // Where an agent's views were left is module state, which outlives a test's router.
  clearViewPositions();
  const queryClient = createQueryClient({ queries: { retry: false } });
  if (session !== undefined) queryClient.setQueryData(sessionQueryOptions.queryKey, session);
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  rendered.add(router);
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
