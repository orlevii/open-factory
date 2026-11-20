import { createFileRoute } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/schedules/$key")({
  component: () => (
    <>
      <PageHeader title="Schedule" />
      <PageBody>{null}</PageBody>
    </>
  ),
});
