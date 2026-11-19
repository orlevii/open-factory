import { useQueries } from "@tanstack/react-query";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import {
  credentialsQueryOptions,
  projectsQueryOptions,
  secretsQueryOptions,
} from "@/features/settings/api";
import { CredentialsSection } from "@/features/settings/credentials-section";
import { ProjectsSection } from "@/features/settings/projects-section";
import { SecretsSection } from "@/features/settings/secrets-section";

const SECTIONS = ["credentials", "secrets", "projects"];

export const Route = createFileRoute("/_app/settings")({
  // ?addSecret=NAME opens the add-secret form with the name filled in (the New agent warnings
  // link here).
  validateSearch: z.object({ addSecret: z.string().optional().catch(undefined) }),
  // Only so the first load shows the pending mark; failures render as the error line.
  loader: async ({ context }) => {
    await Promise.allSettled([
      context.queryClient.ensureQueryData(credentialsQueryOptions),
      context.queryClient.ensureQueryData(secretsQueryOptions),
      context.queryClient.ensureQueryData(projectsQueryOptions),
    ]);
  },
  component: SettingsPage,
});

function SettingsPage() {
  const { addSecret } = Route.useSearch();
  const hash = useLocation({ select: (l) => l.hash });
  const queries = useQueries({
    queries: [credentialsQueryOptions, secretsQueryOptions, projectsQueryOptions],
  });
  const failed = queries.some((q) => q.isError && !q.data);
  const settled = queries.every((q) => !q.isPending);

  // #credentials, #secrets, #projects: bring the section into view once its content is there,
  // and move focus to its heading so keyboard and screen-reader users land there too. With
  // ?addSecret the add form has already taken focus (its value field).
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!settled || !SECTIONS.includes(hash) || handled.current === hash) return;
    handled.current = hash;
    document.getElementById(hash)?.scrollIntoView?.({ block: "start" });
    if (!(addSecret && hash === "secrets")) document.getElementById(`${hash}-title`)?.focus();
  }, [settled, hash, addSecret]);

  return (
    <>
      <PageHeader title="Settings" />
      <PageBody>
        <div className="grid max-w-5xl gap-10">
          {failed && (
            <p role="alert" className="text-sm text-muted-foreground">
              Couldn't load settings.
            </p>
          )}
          <CredentialsSection />
          <SecretsSection addSecret={addSecret} />
          <ProjectsSection />
        </div>
      </PageBody>
    </>
  );
}
