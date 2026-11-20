import { type UsageDays, usageDaysSchema } from "@open-factory/shared";
import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import {
  credentialsQueryOptions,
  factorySettingsQueryOptions,
  invitesQueryOptions,
  projectsQueryOptions,
  secretsQueryOptions,
  usersQueryOptions,
} from "@/features/settings/api";
import { CredentialsSection } from "@/features/settings/credentials-section";
import { FactorySection } from "@/features/settings/factory-section";
import { ProjectsSection } from "@/features/settings/projects-section";
import { SecretsSection } from "@/features/settings/secrets-section";
import { UsageSection } from "@/features/settings/usage-section";
import { UsersSection } from "@/features/settings/users-section";
import { agentsUsageQuery, credentialsUsageQuery, dailyUsageQuery } from "@/features/usage/api";

const SECTIONS = [
  { id: "usage", title: "Usage" },
  { id: "credentials", title: "Credentials" },
  { id: "secrets", title: "Secrets" },
  { id: "projects", title: "Projects" },
  { id: "users", title: "Users" },
  { id: "factory", title: "Factory" },
] as const;
const IDS: readonly string[] = SECTIONS.map((s) => s.id);

const DEFAULT_DAYS: UsageDays = 30;
const searchSchema = z.object({
  // ?addSecret=NAME opens the add-secret form with the name filled in (the New agent warnings
  // link here).
  addSecret: z.string().optional().catch(undefined),
  // The Usage range; an unknown one falls back to the default.
  days: usageDaysSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_app/settings")({
  validateSearch: searchSchema,
  // Only so the first load shows the pending mark (and a #hash lands on loaded content); each
  // section renders its own failure. No loaderDeps: a range switch keeps the previous data.
  loader: async ({ context, location }) => {
    const days = searchSchema.parse(location.search).days ?? DEFAULT_DAYS;
    const qc = context.queryClient;
    await Promise.allSettled([
      qc.ensureQueryData(dailyUsageQuery(days)),
      qc.ensureQueryData(agentsUsageQuery(days)),
      qc.ensureQueryData(credentialsUsageQuery(days)),
      qc.ensureQueryData(credentialsQueryOptions),
      qc.ensureQueryData(secretsQueryOptions),
      qc.ensureQueryData(projectsQueryOptions),
      qc.ensureQueryData(usersQueryOptions),
      qc.ensureQueryData(invitesQueryOptions),
      qc.ensureQueryData(factorySettingsQueryOptions),
    ]);
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { addSecret, days = DEFAULT_DAYS } = Route.useSearch();
  const hash = useLocation({ select: (l) => l.hash });
  const navigate = useNavigate();

  // #usage … #factory: bring the section into view and move focus to its heading, so keyboard
  // and screen-reader users land there too. The loader has already waited for the content. With
  // ?addSecret the add form has already taken focus (its value field).
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!IDS.includes(hash)) {
      handled.current = undefined;
      return;
    }
    if (handled.current === hash) return;
    handled.current = hash;
    document.getElementById(hash)?.scrollIntoView?.({ block: "start" });
    if (!(addSecret && hash === "secrets")) document.getElementById(`${hash}-title`)?.focus();
  }, [hash, addSecret]);
  // A click on the anchor of the current hash changes no location, so the effect above doesn't
  // run: move to the section here.
  const revisit = (id: string) => {
    if (id !== hash) return;
    document.getElementById(id)?.scrollIntoView?.({ block: "start" });
    document.getElementById(`${id}-title`)?.focus();
  };

  return (
    <>
      <PageHeader title="Settings" />
      <PageBody>
        <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-10">
          <nav aria-label="On this page">
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] leading-[1.125rem]">
              {SECTIONS.map((s) => (
                <li key={s.id}>
                  <Link
                    from={Route.fullPath}
                    to="."
                    search={(prev) => prev}
                    hash={s.id}
                    onClick={() => revisit(s.id)}
                    className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {s.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <UsageSection
            days={days}
            onDaysChange={(d) =>
              void navigate({
                from: Route.fullPath,
                to: ".",
                search: (prev) => ({ ...prev, days: d === DEFAULT_DAYS ? undefined : d }),
                hash: true,
                resetScroll: false,
              })
            }
          />
          <CredentialsSection />
          <SecretsSection addSecret={addSecret} />
          <ProjectsSection />
          <UsersSection />
          <FactorySection />
        </div>
      </PageBody>
    </>
  );
}
