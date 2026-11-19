import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { EmptyState } from "@/components/empty-state";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/settings")({
  // ?addSecret=NAME opens the add-secret form with the name filled in (the New agent warnings
  // link here).
  validateSearch: z.object({ addSecret: z.string().optional().catch(undefined) }),
  component: () => (
    <>
      <PageHeader title="Settings" />
      <PageBody>
        <EmptyState text="Nothing to configure yet." />
      </PageBody>
    </>
  ),
});
