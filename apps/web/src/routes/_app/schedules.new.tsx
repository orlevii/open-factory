import { createFileRoute } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/schedules/new")({
  component: () => (
    <>
      <PageHeader title="New schedule" />
      <PageBody>{null}</PageBody>
    </>
  ),
});
