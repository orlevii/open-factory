import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

/** Renders one component inside a minimal router that knows the task routes, so `Link`s resolve to hrefs. */
export function renderInRouter(ui: ReactNode) {
  const root = createRootRoute({ component: () => <>{ui}</> });
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
