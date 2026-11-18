import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { Session } from "@/lib/auth-client";
import { sessionQueryOptions } from "@/lib/session";
import { createAppRouter } from "@/router";

export const alice = {
  user: { id: "u1", name: "Alice", handle: "alice", email: "alice@example.com" },
  session: { id: "s1" },
} as unknown as Session;

/** Renders the real route tree at `path` with the session query pre-seeded. */
export function renderApp(path: string, session: Session | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionQueryOptions.queryKey, session);
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
