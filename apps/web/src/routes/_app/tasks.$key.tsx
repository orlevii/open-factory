import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_app/tasks/$key")({
  validateSearch: z.object({ comment: z.string().min(1).optional().catch(undefined) }),
  component: () => <PageHeader title="Task" />,
});
