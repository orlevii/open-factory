import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ShellContext } from "@/components/shell-context";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useConnectionLost } from "@/lib/connection";
import { sessionQueryOptions } from "@/lib/session";
import { connectWs, type WsStatus } from "@/lib/ws";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions);
    if (!session) throw redirect({ to: "/sign-in" });
    return { session };
  },
  component: AppLayout,
});

/** shadcn writes this cookie on every toggle; reading it keeps the collapsed state across reloads. */
const sidebarOpenFromCookie = () => !document.cookie.split("; ").includes("sidebar_state=false");

function AppLayout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState<WsStatus>("connecting");
  useEffect(() => {
    const conn = connectWs({
      // A failed check (5xx, network) rejects; connectWs then keeps retrying instead of signing out.
      hasSession: async () => {
        await qc.invalidateQueries({ queryKey: ["session"] });
        return Boolean(await qc.fetchQuery(sessionQueryOptions));
      },
      onUnauthenticated: () => navigate({ to: "/sign-in" }),
      onStatus: setStatus,
    });
    setStatus(conn.status());
    return () => conn.close();
  }, [qc, navigate]);
  const connectionLost = useConnectionLost(status);
  const shell = useMemo(() => ({ connectionLost }), [connectionLost]);
  const [defaultOpen] = useState(sidebarOpenFromCookie);

  return (
    <ShellContext.Provider value={shell}>
      <SidebarProvider
        defaultOpen={defaultOpen}
        style={{ "--sidebar-width": "15rem" } as CSSProperties}
      >
        <a
          href="#content"
          className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50"
        >
          Skip to content
        </a>
        <AppSidebar />
        {/* SidebarInset renders the single <main> landmark; each screen renders its PageHeader. */}
        <SidebarInset id="content" tabIndex={-1} className="min-w-0 outline-none">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </ShellContext.Provider>
  );
}
