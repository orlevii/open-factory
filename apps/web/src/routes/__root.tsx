import type { QueryClient } from "@tanstack/react-query";
import { type AnyRouter, createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient; router: AnyRouter }>()({
  component: () => (
    <TooltipProvider>
      <Outlet />
    </TooltipProvider>
  ),
});
