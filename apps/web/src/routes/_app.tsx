import type { AgentConfigResponse, AgentDetail, ServerMessage } from "@open-factory/shared";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { ShellContext } from "@/components/shell-context";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster, notify as toast } from "@/components/ui/toaster";
import { onRestartFrame, resetRestartLatch } from "@/features/agents/lifecycle";
import { RestartConfirmHost } from "@/features/agents/restart-confirm";
import { enqueueStatusFrame, installStatusFrameFlush } from "@/features/agents/status-frames";
import { onChatChanged } from "@/features/chat/use-chat";
import { agentConfigQueryOptions, templateConfigQueryOptions } from "@/features/config/api";
import { useInboxNotifier } from "@/features/inbox/notifications";
import { createOrgToasts } from "@/features/org/org-toasts";
import { CommandPalette } from "@/features/palette/command-palette";
import { summaryFromAgentsList } from "@/features/session/api";
import { invalidateCommands } from "@/features/session/commands";
import { dropUploadsExcept } from "@/features/session/uploads";
import { setupQueryOptions } from "@/features/setup/api";
import { preloadAllSheets } from "@/features/sheets/sheet-bodies";
import { SheetHost } from "@/features/sheets/sheet-host";
import { GlobalShortcuts } from "@/features/shortcuts/global-shortcuts";
import { useConnectionLost } from "@/lib/connection";
import { installFileDropGuard } from "@/lib/file-drop";
import { invalidateLibrary, onLibraryChanged } from "@/lib/library";
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
  // Uploads belong to the signed-in user (U3 §13.5): composers read their store by user id, and a user
  // change here drops every other user's (aborting what is in flight).
  const userId = useQuery(sessionQueryOptions).data?.user.id;
  useEffect(() => {
    if (userId !== undefined) dropUploadsExcept(userId);
  }, [userId]);
  const [status, setStatus] = useState<WsStatus>("connecting");
  const [openCount, setOpenCount] = useState(0);
  const listeners = useRef(new Set<(m: ServerMessage) => void>());
  const conn = useRef<WsConnection | null>(null);
  const notify = useInboxNotifier();
  // Last `turnOpen` per agent: a true to false edge is a finished turn, whose cost the usage views refetch.
  const turnOpen = useRef(new Map<string, boolean>());
  const usageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opened = useRef(false);
  useEffect(() => installShortcuts(), []);
  // A file dropped outside the composer never navigates away from the app (U3 §13.5).
  useEffect(() => installFileDropGuard(), []);
  useEffect(() => {
    const orgToasts = createOrgToasts({ notify: toast, navigate: (to) => navigate({ to }) });
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
        // Restart now's pending latch ends on the next status frame or an error event.
        onRestartFrame(m);
        // A message reached the humans: refetch the Inbox (only a mounted list actually fetches).
        if (m.type === "inbox_changed") {
          void qc.invalidateQueries({ queryKey: ["inbox"] });
          void qc.invalidateQueries({ queryKey: ["inbox-unread"] });
          void qc.invalidateQueries({ queryKey: ["inbox-home"] });
          notify();
        }
        // I1: a chat on screen refreshes its newest page (one request in flight, one trailing).
        onChatChanged(qc, m);
        // I1: an agent started, so its `/` list is stale (an open menu fetches it again).
        invalidateCommands(qc, m);
        // S8: the list, an open detail page and the agents' open-task counts refetch (only mounted ones fetch).
        if (m.type === "tasks_changed") {
          void qc.invalidateQueries({ queryKey: ["tasks"] });
          void qc.invalidateQueries({ queryKey: ["agents"] });
          void qc.invalidateQueries({ queryKey: ["agent"] });
        }
        // I5: the Skills views refetch once per 250 ms window (only mounted ones fetch).
        if (m.type === "library_changed") onLibraryChanged(qc, m);
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
        // I2 §12.4: an open Configuration page (or template tab) refetches; nothing else reads these keys.
        if (m.type === "config_changed") {
          // I5 §9.5: a template or agent change moves the Skills lists and used-by counts.
          invalidateLibrary(qc);
          if (m.agent)
            void qc.invalidateQueries({
              queryKey: agentConfigQueryOptions(m.agent).queryKey,
              exact: true,
            });
          if (m.template) {
            const template = m.template;
            void qc.invalidateQueries({
              queryKey: templateConfigQueryOptions(template).queryKey,
              exact: true,
            });
            // An open agent page on this template: it may have just turned broken (or fixed), which no per-agent
            // frame reports. Only mounted queries refetch.
            void qc.invalidateQueries({
              queryKey: ["agent-config"],
              predicate: (q) =>
                (q.state.data as AgentConfigResponse | undefined)?.template.name === template,
            });
          }
        }
        // I7: an agent changed the org: one merged toast per actor window; the lists it touched refetch.
        if (m.type === "org_action") {
          orgToasts.onOrgAction(m);
          // An org action means an agent exists: only a cache still saying otherwise needs the refetch.
          if (qc.getQueryData(setupQueryOptions.queryKey)?.hasAgent === false)
            void qc.invalidateQueries({ queryKey: setupQueryOptions.queryKey });
          if (m.action === "template_created")
            void qc.invalidateQueries(
              { queryKey: ["templates"], exact: true },
              { cancelRefetch: false },
            );
          else {
            void qc.invalidateQueries({ queryKey: ["agents"] });
            void qc.invalidateQueries({ queryKey: ["agent", m.subject] });
          }
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
        // A status frame dropped while the socket was down would leave "Restarting…" until reload.
        resetRestartLatch();
        // The first open follows the loaders' fetches; a reconnect may have missed turn ends and
        // supervisor frames while the socket was down.
        if (!opened.current) {
          opened.current = true;
          return;
        }
        // Only mounted queries refetch; the rest are marked stale.
        // Chats refresh their newest page themselves (the union), never wholesale.
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "chat" });
      },
    });
    conn.current = connection;
    setStatus(connection.status());
    const removeFlush = installStatusFrameFlush();
    return () => {
      removeFlush();
      orgToasts.dispose();
      connection.close();
      conn.current = null;
      clearTimeout(usageTimer.current);
      usageTimer.current = undefined;
    };
  }, [qc, navigate, notify]);
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

  // After first paint, fetch every sheet body's chunk so the skeleton is rare.
  useEffect(() => {
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(() => preloadAllSheets());
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(preloadAllSheets, 1000);
    return () => clearTimeout(id);
  }, []);

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
          <Toaster />
          <CommandPalette />
          <GlobalShortcuts />
          <SheetHost />
          <RestartConfirmHost />
        </SidebarProvider>
      </ShellContext.Provider>
    </WsContext.Provider>
  );
}
