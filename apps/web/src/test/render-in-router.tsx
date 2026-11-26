import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { createQueryClient } from "@/lib/query-client";

/** Renders one component inside a minimal router that knows the task routes, so `Link`s resolve to hrefs. */
export function renderInRouter(ui: ReactNode) {
  // Components here may read the principals cache (a task badge's title).
  const qc = createQueryClient({ queries: { retry: false } });
  const root = createRootRoute({ component: () => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      stub("/tasks/$key"),
      stub("/tasks"),
      stub("/agents/$slug"),
      stub("/agents"),
      stub("/agents/new"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}
