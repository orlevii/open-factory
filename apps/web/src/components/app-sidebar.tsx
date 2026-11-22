import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bot,
  CalendarClock,
  ChartColumn,
  ChevronDown,
  ChevronsUpDown,
  Inbox,
  LayoutTemplate,
  ListTodo,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { TruncTooltip } from "@/components/agent-chip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isMac, Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Mark, Wordmark } from "@/components/wordmark";
import { SidebarAgentTree } from "@/features/agents/sidebar-tree";
import { useIsLiveAgent } from "@/features/agents/use-agent-index";
import { useUnreadCount } from "@/features/inbox/api";
import { BLOCKED_NOTE, useBrowserNotifications } from "@/features/inbox/notifications";
import { openPalette, prefetchPaletteData } from "@/features/palette/command-palette";
import { resetUploads } from "@/features/session/uploads";
import { resetDrafts } from "@/features/sheets/drafts";
import { resetSheets } from "@/features/sheets/sheet-store";
import { authClient } from "@/lib/auth-client";
import { usePref } from "@/lib/prefs";
import { refreshSession, sessionQueryOptions } from "@/lib/session";
import { setPreference, type ThemePreference, useThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

const themes = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const satisfies readonly { value: ThemePreference; label: string; icon: unknown }[];

const nav = [
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/templates", label: "Templates", icon: LayoutTemplate },
  { to: "/schedules", label: "Schedules", icon: CalendarClock },
  { to: "/usage", label: "Usage", icon: ChartColumn },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

/** A section stays highlighted on its detail routes (/agents/foo). "/" redirects to the Inbox. */
const isActive = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

/** The slug of `/agents/$slug` itself, not of its /edit or /usage children. */
function matchSession(pathname: string): string | undefined {
  const m = /^\/agents\/([^/]+)\/?$/.exec(pathname);
  const slug = m?.[1];
  return slug && slug !== "new" ? decodeURIComponent(slug) : undefined;
}

const parseCollapsed = (raw: string) =>
  raw === "true" ? true : raw === "false" ? false : undefined;

const sidebarTrigger = () => document.querySelector<HTMLElement>('[data-sidebar="trigger"]');

export function AppSidebar() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile, state } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeSlug = useRouterState({ select: (s) => matchSession(s.location.pathname) });
  const live = useIsLiveAgent(activeSlug ?? "");
  // The drawer always shows the full tree; only the desktop rail is compressed.
  const collapsedRail = state === "collapsed" && !isMobile;
  const [treeCollapsed, setTreeCollapsed] = usePref("of-tree-collapsed", false, parseCollapsed);
  // An ended agent's session belongs to the Agents section; a live one's row is the highlight,
  // unless the tree is hidden (collapsed by the chevron, not the rail). Not active until we know.
  const agentsActive =
    isActive(pathname, "/agents") &&
    (!activeSlug || live === false || (live === true && treeCollapsed && !collapsedRail));
  // The _app guard has already loaded this query; it is null only for a moment during sign-out.
  const { data: session } = useQuery(sessionQueryOptions);
  const user = session?.user;
  const theme = useThemePreference();
  const { data: unread = 0 } = useUnreadCount();
  const notifications = useBrowserNotifications();

  async function signOut() {
    // In-flight uploads stop and every file of this user is dropped from memory (U3 §13.5).
    resetUploads();
    resetSheets();
    resetDrafts();
    await authClient.signOut();
    await refreshSession(qc);
    await navigate({ to: "/sign-in" });
  }

  // The shadcn sheet does not close itself when a link inside it is followed.
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-12 justify-center px-3 py-0 group-data-[collapsible=icon]:px-2">
        <Link
          to="/inbox"
          onClick={closeMobile}
          aria-label="Open Factory"
          className="flex items-center rounded-md group-data-[collapsible=icon]:justify-center"
        >
          <Wordmark className="h-5 group-data-[collapsible=icon]:hidden" />
          <Mark className="hidden size-5 group-data-[collapsible=icon]:block" />
        </Link>
      </SidebarHeader>
      <SidebarContent className="min-h-0 flex-col overflow-hidden">
        {/* Opens the palette: a button, never active, with a rule under it (spec §10.2). */}
        <SidebarGroup className="shrink-0 pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Search"
                aria-label="Search"
                aria-keyshortcuts={isMac() ? "Meta+K" : "Control+K"}
                onPointerEnter={() => prefetchPaletteData(qc)}
                onFocus={() => prefetchPaletteData(qc)}
                onClick={() => {
                  closeMobile();
                  // The row closes with the drawer: a plain close returns to the header's menu button.
                  openPalette(isMobile ? sidebarTrigger : undefined);
                }}
                className={cn("gap-2.5 transition-colors duration-150", isMobile ? "h-9" : "h-8")}
              >
                <Search aria-hidden="true" />
                <span>Search</span>
                <Kbd keys={["Mod", "K"]} className="ml-auto group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarSeparator className="group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:w-6" />
        <SidebarGroup className="shrink-0">
          <SidebarGroupContent>
            <nav aria-label="Main">
              <SidebarMenu>
                {nav.map((item) => {
                  const active = isActive(pathname, item.to);
                  const count = item.to === "/inbox" ? unread : 0;
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={count ? `${item.label} · ${count} unread` : item.label}
                        className={cn(
                          "relative gap-2.5 transition-colors duration-150",
                          isMobile ? "h-9" : "h-8",
                        )}
                      >
                        <Link
                          to={item.to}
                          onClick={closeMobile}
                          aria-current={active ? "page" : undefined}
                          {...(count ? { "aria-label": `${item.label}, ${count} unread` } : {})}
                        >
                          {/* The active marker is one roof tooth at the 30° pitch (DESIGN.md). */}
                          {active && (
                            <span
                              aria-hidden="true"
                              className="of-tooth absolute top-1/2 left-0 -translate-y-1/2 group-data-[collapsible=icon]:-left-1"
                            />
                          )}
                          <item.icon aria-hidden="true" />
                          <span>{item.label}</span>
                          {count > 0 && (
                            <>
                              {/* Ink, never orange: the count is information, not "live". */}
                              <span
                                aria-hidden="true"
                                className="ml-auto text-[0.8125rem] text-muted-foreground tabular-nums group-data-[collapsible=icon]:hidden"
                              >
                                {count > 99 ? "99+" : count}
                              </span>
                              <span
                                aria-hidden="true"
                                className="absolute top-1.5 right-1.5 hidden size-1.5 rounded-full bg-foreground group-data-[collapsible=icon]:block"
                              />
                            </>
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
        {collapsedRail && <SidebarSeparator decorative={false} className="mx-auto w-6" />}
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto pt-0">
          <SidebarGroupContent>
            {/* The nav row for /agents and the head of the tree; it stays put while the tree scrolls. */}
            <SidebarMenu className="sticky top-0 z-10 bg-sidebar">
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={agentsActive}
                  tooltip="Agents"
                  className={cn(
                    "relative gap-2.5 transition-colors duration-150",
                    isMobile ? "h-9" : "h-8",
                  )}
                >
                  <Link
                    to="/agents"
                    // The router's own prefix match would mark it on every live session too.
                    activeOptions={{ exact: true }}
                    onClick={closeMobile}
                    aria-current={agentsActive ? "page" : undefined}
                  >
                    {agentsActive && (
                      <span
                        aria-hidden="true"
                        className="of-tooth absolute top-1/2 left-0 -translate-y-1/2 group-data-[collapsible=icon]:-left-1"
                      />
                    )}
                    <Bot aria-hidden="true" />
                    <span>Agents</span>
                  </Link>
                </SidebarMenuButton>
                {!collapsedRail && (
                  <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Link
                          to="/agents/new"
                          onClick={closeMobile}
                          aria-label="New agent"
                          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        >
                          <Plus aria-hidden="true" className="size-4" />
                        </Link>
                      </TooltipTrigger>
                      <TooltipContent>New agent</TooltipContent>
                    </Tooltip>
                    <button
                      type="button"
                      aria-label={treeCollapsed ? "Expand agents" : "Collapse agents"}
                      aria-expanded={!treeCollapsed}
                      onClick={() => setTreeCollapsed(!treeCollapsed)}
                      className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    >
                      <ChevronDown
                        aria-hidden="true"
                        className={cn("size-4", treeCollapsed && "-rotate-90")}
                      />
                    </button>
                  </div>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
            {(collapsedRail || !treeCollapsed) && (
              <SidebarAgentTree activeSlug={activeSlug} collapsedRail={collapsedRail} />
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  {/* Icon mode: the handle's first letter is all that fits. */}
                  <span
                    aria-hidden="true"
                    className="hidden size-8 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[0.8125rem] text-muted-foreground uppercase group-data-[collapsible=icon]:flex"
                  >
                    {user?.handle?.[0]}
                  </span>
                  <div className="grid flex-1 text-left leading-tight group-data-[collapsible=icon]:sr-only">
                    <TruncTooltip text={user?.name ?? ""}>
                      <span className="truncate text-sm font-medium">{user?.name}</span>
                    </TruncTooltip>
                    <TruncTooltip text={`@${user?.handle}`}>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        @{user?.handle}
                      </span>
                    </TruncTooltip>
                  </div>
                  <ChevronsUpDown
                    aria-hidden="true"
                    className="ml-auto group-data-[collapsible=icon]:hidden"
                  />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-56">
                <DropdownMenuLabel className="grid gap-0.5 font-normal">
                  <span className="truncate text-sm font-medium text-foreground">{user?.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    @{user?.handle}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Theme
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(value) => setPreference(value as ThemePreference)}
                >
                  {themes.map((t) => (
                    <DropdownMenuRadioItem key={t.value} value={t.value}>
                      <t.icon aria-hidden="true" />
                      {t.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                {notifications.supported && (
                  <>
                    <DropdownMenuSeparator />
                    {/* preventDefault keeps the menu open, so the description under the switch is seen. */}
                    <DropdownMenuCheckboxItem
                      checked={notifications.enabled}
                      onSelect={(e) => {
                        e.preventDefault();
                        void notifications.toggle();
                      }}
                    >
                      Browser notifications
                    </DropdownMenuCheckboxItem>
                    {notifications.blocked && (
                      <p className="px-2 pb-1 text-xs text-muted-foreground">{BLOCKED_NOTE}</p>
                    )}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void signOut()}>
                  <LogOut aria-hidden="true" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
