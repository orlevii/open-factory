import type { AgentDetail, ServerMessage } from "@open-factory/shared";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ShellContext } from "@/components/shell-context";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { enqueueStatusFrame, installStatusFrameFlush } from "@/features/agents/status-frames";
import { useInboxNotifier } from "@/features/inbox/notifications";
import { summaryFromAgentsList } from "@/features/session/api";
import { useConnectionLost } from "@/lib/connection";
import { SESSION_GUARD_RETRIES, sessionQueryOptions } from "@/lib/session";
import { installShortcuts } from "@/lib/shortcuts";
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

const USAGE_DEBOUNCE_MS = 5000;

/** `turnOpen` for an agent as the cached agent lists or detail last saw it; undefined when uncached. */
function cachedTurnOpen(qc: QueryClient, slug: string): boolean | undefined {
  return (
    summaryFromAgentsList(qc, slug)?.turnOpen ??
    qc.getQueryData<AgentDetail>(["agent", slug])?.agent.turnOpen
  );
}

/** shadcn writes this cookie on every toggle; reading it keeps the collapsed state across reloads. */
const sidebarOpenFromCookie = () => !document.cookie.split("; ").includes("sidebar_state=false");

function AppLayout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState<WsStatus>("connecting");
  const [openCount, setOpenCount] = useState(0);
  const listeners = useRef(new Set<(m: ServerMessage) => void>());
  const conn = useRef<WsConnection | null>(null);
  const notify = useInboxNotifier();
  // Last `turnOpen` per agent: a true to false edge is a finished turn, whose cost the usage views refetch.
  const turnOpen = useRef(new Map<string, boolean>());
  const usageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opened = useRef(false);
  // The socket outlives renders: it always calls the latest notifier.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => installShortcuts(), []);
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
        // agent_status and supervisor frames are folded into the caches once per animation frame.
        enqueueStatusFrame(qc, m);
        // A message reached the humans: refetch the Inbox (only a mounted list actually fetches).
        if (m.type === "inbox_changed") {
          void qc.invalidateQueries({ queryKey: ["inbox"] });
          void qc.invalidateQueries({ queryKey: ["inbox-unread"] });
          void qc.invalidateQueries({ queryKey: ["inbox-home"] });
          notifyRef.current();
        }
        // S8: the list, an open detail page and the agents' open-task counts refetch (only mounted ones fetch).
        if (m.type === "tasks_changed") {
          void qc.invalidateQueries({ queryKey: ["tasks"] });
          void qc.invalidateQueries({ queryKey: ["agents"] });
          void qc.invalidateQueries({ queryKey: ["agent"] });
        }
        // S9: the Schedules page, an open edit page and the agents' schedule counts refetch (only mounted ones fetch).
        if (m.type === "schedules_changed") {
          void qc.invalidateQueries({ queryKey: ["schedules"] });
          void qc.invalidateQueries({ queryKey: ["agents"] });
          void qc.invalidateQueries({ queryKey: ["agent"] });
        }
        // S10: admin screens and usage views (only mounted ones fetch).
        if (m.type === "settings_changed") {
          void qc.invalidateQueries({ queryKey: ["factory-settings"] });
        }
        if (m.type === "users_changed") {
          void qc.invalidateQueries({ queryKey: ["users"] });
          void qc.invalidateQueries({ queryKey: ["invites"] });
        }
        // Only a build's start and end frames (no `lines`) change a status; the 250 ms log batches
        // in between would refetch the list and every open template several times a second.
        if (m.type === "images_changed" || (m.type === "image_build" && !m.lines)) {
          void qc.invalidateQueries({ queryKey: ["images"] });
          void qc.invalidateQueries({ queryKey: ["templates"] });
        }
        if (m.type === "agent_status") {
          // Before the first frame for an agent, the cached list or detail (fetched over REST) tells
          // whether a turn was already open when the socket connected. The queued frame lands on a
          // later animation frame, so the cache still holds the state from before it.
          const was = turnOpen.current.get(m.agent) ?? cachedTurnOpen(qc, m.agent);
          turnOpen.current.set(m.agent, m.turnOpen);
          // A 5 s window that further edges don't extend: a busy factory still refreshes.
          if (was === true && !m.turnOpen && usageTimer.current === undefined) {
            usageTimer.current = setTimeout(() => {
              usageTimer.current = undefined;
              void qc.invalidateQueries({ queryKey: ["usage"] });
            }, USAGE_DEBOUNCE_MS);
          }
        }
        for (const fn of listeners.current) fn(m);
      },
      onOpen: () => {
        setOpenCount((n) => n + 1);
        // The first open follows the loaders' fetches; a reconnect may have missed turn ends and
        // supervisor frames while the socket was down.
        if (!opened.current) {
          opened.current = true;
          return;
        }
        // Only mounted queries refetch; the rest are marked stale.
        void qc.invalidateQueries();
      },
    });
    conn.current = connection;
    setStatus(connection.status());
    const removeFlush = installStatusFrameFlush();
    return () => {
      removeFlush();
      connection.close();
      conn.current = null;
      clearTimeout(usageTimer.current);
      usageTimer.current = undefined;
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
          <SidebarInset
            id="content"
            tabIndex={-1}
            className="relative min-w-0 outline-none" // ui-contract:allow skip-link target, not interactive
          >
            <Outlet />
          </SidebarInset>
        </SidebarProvider>
      </ShellContext.Provider>
    </WsContext.Provider>
  );
}
