import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGES = [
  { to: "/settings/credentials", title: "Credentials" },
  { to: "/settings/secrets", title: "Secrets" },
  { to: "/settings/projects", title: "Projects" },
  { to: "/settings/users", title: "Users" },
  { to: "/settings/factory", title: "Factory" },
] as const;

export const Route = createFileRoute("/_app/settings")({ component: SettingsLayout });

function SettingsLayout() {
  const navigate = useNavigate();
  const current = useRouterState({
    select: (s) => PAGES.find((p) => s.location.pathname.split("/")[2] === p.to.split("/")[2])?.to,
  });
  return (
    <>
      <PageHeader title="Settings" />
      <PageBody>
        {/* The container is the body: 11.25rem of sub-nav + the 2.5rem gap + the 40rem the content
            needs is 53.75rem. Narrower than that, the sub-nav becomes a Section select. */}
        <div className="@container">
          <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-6 @min-[53.75rem]:grid-cols-[11.25rem_minmax(0,1fr)] @min-[53.75rem]:gap-10">
            <nav aria-label="Settings" className="hidden @min-[53.75rem]:block">
              <ul className="grid gap-0.5">
                {PAGES.map((p) => (
                  <li key={p.to}>
                    <Link
                      to={p.to}
                      className="flex h-8 items-center rounded-md px-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                      activeProps={{ className: "bg-accent font-medium text-foreground" }}
                    >
                      {p.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            {/* As wide as a section name needs, not the content: 15rem, or less on a phone. */}
            <div className="w-full max-w-60 @min-[53.75rem]:hidden">
              <Select
                value={current}
                onValueChange={(to) => void navigate({ to: to as (typeof PAGES)[number]["to"] })}
              >
                <SelectTrigger aria-label="Section">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGES.map((p) => (
                    <SelectItem key={p.to} value={p.to}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0">
              <Outlet />
            </div>
          </div>
        </div>
      </PageBody>
    </>
  );
}
