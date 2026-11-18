import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { sessionQueryOptions } from "@/lib/session";
import { connectWs } from "@/lib/ws";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (!session) throw redirect({ to: "/sign-in" });
    return { session };
  },
  component: AppLayout,
});

function AppLayout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    const conn = connectWs({
      hasSession: async () => {
        await qc.invalidateQueries({ queryKey: ["session"] });
        return Boolean(await qc.fetchQuery(sessionQueryOptions));
      },
      onUnauthenticated: () => navigate({ to: "/sign-in" }),
    });
    return () => conn.close();
  }, [qc, navigate]);
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center px-4 md:hidden">
          <SidebarTrigger />
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
