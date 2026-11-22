import { ApiError } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";
import { ResourceNotFound } from "@/components/route-states";
import { templateQueryOptions } from "@/features/templates/api";
import { TemplateEditor } from "@/features/templates/template-editor";

export const Route = createFileRoute("/_app/templates/$name")({
  // Only so the first load shows the pending mark and an unknown name the not-found state.
  loader: async ({ context, params, preload }) => {
    const opts = templateQueryOptions(params.name);
    // The editor chunk starts loading with the data on a real visit; a hover elsewhere doesn't fetch it.
    if (!preload) void import("@/features/templates/code-editor");
    try {
      // A hover warms the cache once (ensureQueryData); a click always refetches, because templates are
      // rescanned from disk (staleTime 0).
      await (preload
        ? context.queryClient.ensureQueryData(opts)
        : context.queryClient.fetchQuery(opts));
    } catch (e) {
      if (e instanceof ApiError && e.code === "template_not_found") throw notFound();
      // Anything else: the page shows the error line.
    }
  },
  notFoundComponent: () => (
    <ResourceNotFound
      title="Template not found."
      backTo="/templates"
      backLabel="Back to templates"
    />
  ),
  component: TemplatePage,
});

function TemplatePage() {
  const { name } = Route.useParams();
  const { data, isError } = useQuery(templateQueryOptions(name));
  if (!data) {
    return (
      <>
        <PageHeader title={name} />
        <PageBody>
          {isError && (
            <p role="alert" className="text-sm text-muted-foreground">
              Couldn't load this template.
            </p>
          )}
        </PageBody>
      </>
    );
  }
  // Seeded once from the loaded files; a refetch must not overwrite what is being typed.
  return <TemplateEditor key={name} template={data} />;
}
