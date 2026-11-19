import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { InlineOutcome } from "@/components/inline-outcome";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { deletedTemplateFrom, templatesQueryOptions } from "@/features/templates/api";
import { TemplateList } from "@/features/templates/template-list";

export const Route = createFileRoute("/_app/templates/")({ component: TemplatesPage });

function TemplatesPage() {
  const { data, isError } = useQuery({ ...templatesQueryOptions, refetchOnMount: "always" });
  const deleted = useLocation({ select: (l) => deletedTemplateFrom(l.state) });
  return (
    <>
      <PageHeader
        title="Templates"
        actions={
          <Button variant="ghost" asChild>
            <Link to="/templates/new">
              <Plus aria-hidden="true" data-icon="inline-start" />
              New template
            </Link>
          </Button>
        }
      />
      <PageBody>
        <div className="grid gap-4">
          {deleted && <InlineOutcome tone="success">Deleted {deleted}.</InlineOutcome>}
          {isError && !data && (
            <p role="alert" className="text-sm text-muted-foreground">
              Couldn't load templates.
            </p>
          )}
          {data && <TemplateList dir={data.dir} templates={data.templates} />}
        </div>
      </PageBody>
    </>
  );
}
