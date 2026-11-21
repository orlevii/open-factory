import type { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { AppPending, NotFound, RouteError } from "./components/route-states";
import { routeTree } from "./routeTree.gen";

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    history,
    // Hovering or focusing a link starts its loader; React Query's staleTime, not the router, decides freshness.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: AppPending,
    defaultPendingMs: 400,
    defaultPendingMinMs: 300,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
