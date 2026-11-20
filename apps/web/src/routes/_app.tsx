import type { ServerMessage } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ShellContext } from "@/components/shell-context";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { useConnectionLost } from "@/lib/connection";
import { SESSION_GUARD_RETRIES, sessionQueryOptions } from "@/lib/session";
import { connectWs, type WsConnection, type WsStatus } from "@/lib/ws";
import { WsContext, type WsHub } from "@/lib/ws-context";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    // A cached session is returned as is (a later failed check keeps it); only an empty cache fetches.
    const session = await context.queryClient.ensureQueryData({
      ...sessionQueryOptions,
      retry: SESSION_GUARD_RETRIES,
    });
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
  const [openCount, setOpenCount] = useState(0);
  const listeners = useRef(new Set<(m: ServerMessage) => void>());
  const conn = useRef<WsConnection | null>(null);
  useEffect(() => {
    const connection = connectWs({
      // A failed check (5xx, network) rejects; connectWs then keeps retrying instead of signing out.
      hasSession: async () => {
        await qc.invalidateQueries({ queryKey: ["session"] });
        return Boolean(await qc.fetchQuery(sessionQueryOptions));
      },
      onUnauthenticated: () => navigate({ to: "/sign-in" }),
      onStatus: setStatus,
      onMessage: (m) => {
        for (const fn of listeners.current) fn(m);
      },
      onOpen: () => setOpenCount((n) => n + 1),
    });
    conn.current = connection;
    setStatus(connection.status());
    return () => {
      connection.close();
      conn.current = null;
    };
  }, [qc, navigate]);
  const hub = useMemo<WsHub>(
    () => ({
      send: (m) => conn.current?.send(m) ?? false,
      listen: (fn) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
      status,
      openCount,
    }),
    [status, openCount],
  );
  const connectionLost = useConnectionLost(status);
  const shell = useMemo(() => ({ connectionLost }), [connectionLost]);
  const [defaultOpen] = useState(sidebarOpenFromCookie);

  return (
    <WsContext.Provider value={hub}>
      <ShellContext.Provider value={shell}>
        <SidebarProvider
          defaultOpen={defaultOpen}
          style={{ "--sidebar-width": "15rem" } as CSSProperties}
        >
          {/* biome-ignore lint/a11y/useValidAnchor: a skip link is in-page navigation; href keeps it a
            real link (works without JS, announced as a link), onClick only bypasses router hash handling. */}
          <a
            href="#content"
            // Move focus directly; leaving the hash to the router would navigate instead.
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("content")?.focus();
            }}
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
    </WsContext.Provider>
  );
}
