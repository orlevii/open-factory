import type { QueryClient } from "@tanstack/react-query";
import { type AnyRouter, createRouter, type RouterHistory } from "@tanstack/react-router";
import { AppPending, NotFound, RouteError } from "./components/route-states";
import { routeTree } from "./routeTree.gen";

export function createAppRouter(
  queryClient: QueryClient,
  history?: RouterHistory,
  /** Tests swap in a throwaway tree; the app always uses the generated one. */
  tree: typeof routeTree = routeTree,
) {
  const router = createRouter({
    routeTree: tree,
    // `router` is filled in below; beforeLoad hooks (sheet redirects) need the live instance.
    context: { queryClient, router: undefined as unknown as AnyRouter },
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
  router.update({ context: { queryClient, router } });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
