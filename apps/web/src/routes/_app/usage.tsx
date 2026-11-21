import { type UsageDays, usageDaysSchema } from "@open-factory/shared";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { UsageSection } from "@/features/settings/usage-section";
import { agentsUsageQuery, credentialsUsageQuery, dailyUsageQuery } from "@/features/usage/api";

const DEFAULT_DAYS: UsageDays = 30;
const searchSchema = z.object({
  // An unknown range falls back to the default rather than an error page.
  days: usageDaysSchema.optional().catch(undefined),
});

export const Route = createFileRoute("/_app/usage")({
  validateSearch: searchSchema,
  // Warms the three queries so the first paint has data. No loaderDeps: a range switch must not
  // block the navigation (the page keeps the previous range on screen). A failure shows in the
  // page's error line, not the route's.
  loader: async ({ context, location }) => {
    const days = searchSchema.parse(location.search).days ?? DEFAULT_DAYS;
    const qc = context.queryClient;
    await Promise.allSettled([
      qc.ensureQueryData(dailyUsageQuery(days)),
      qc.ensureQueryData(agentsUsageQuery(days)),
      qc.ensureQueryData(credentialsUsageQuery(days)),
    ]);
  },
  component: UsagePage,
});

function UsagePage() {
  const days = Route.useSearch().days ?? DEFAULT_DAYS;
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Usage" />
      <PageBody>
        <div className="max-w-5xl">
          <UsageSection
            days={days}
            onDaysChange={(d) =>
              void navigate({ to: "/usage", search: d === DEFAULT_DAYS ? {} : { days: d } })
            }
          />
        </div>
      </PageBody>
    </>
  );
}
