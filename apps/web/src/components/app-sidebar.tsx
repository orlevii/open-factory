import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bot,
  CalendarClock,
  ChevronsUpDown,
  Inbox,
  LayoutTemplate,
  ListTodo,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { Mark, Wordmark } from "@/components/wordmark";
import { useUnreadCount } from "@/features/inbox/api";
import { BLOCKED_NOTE, useBrowserNotifications } from "@/features/inbox/notifications";
import { authClient } from "@/lib/auth-client";
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
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/templates", label: "Templates", icon: LayoutTemplate },
  { to: "/schedules", label: "Schedules", icon: CalendarClock },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

/** A section stays highlighted on its detail routes (/agents/foo). "/" highlights nothing. */
const isActive = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

export function AppSidebar() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The _app guard has already loaded this query; it is null only for a moment during sign-out.
  const { data: session } = useQuery(sessionQueryOptions);
  const user = session?.user;
  const theme = useThemePreference();
  const { data: unread = 0 } = useUnreadCount();
  const notifications = useBrowserNotifications();

  async function signOut() {
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
          to="/"
          onClick={closeMobile}
          aria-label="Open Factory"
          className="flex items-center rounded-md group-data-[collapsible=icon]:justify-center"
        >
          <Wordmark className="h-5 group-data-[collapsible=icon]:hidden" />
          <Mark className="hidden size-5 group-data-[collapsible=icon]:block" />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
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
                    <span className="truncate text-sm font-medium">{user?.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      @{user?.handle}
                    </span>
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
