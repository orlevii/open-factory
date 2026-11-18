import { createFileRoute } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";

// Placeholder so the Agents list can link to it; Task 17 replaces this with the session view.
export const Route = createFileRoute("/_app/agents/$slug")({
  component: () => (
    <>
      <PageHeader title="Agent" />
      <PageBody>{null}</PageBody>
    </>
  ),
});
