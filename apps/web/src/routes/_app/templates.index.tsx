import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { clearedState, deletedTemplateFrom, templatesQueryOptions } from "@/features/templates/api";
import { ImagesSection } from "@/features/templates/images-section";
import { TemplateList } from "@/features/templates/template-list";

export const Route = createFileRoute("/_app/templates/")({ component: TemplatesPage });

function TemplatesPage() {
  const { data, isError } = useQuery({ ...templatesQueryOptions, refetchOnMount: "always" });
  const fromState = useLocation({ select: (l) => deletedTemplateFrom(l.state) });
  const navigate = useNavigate();
  // Read the one-shot notice, then clear it from the history entry so a reload or Back doesn't
  // repeat it. It is set from an effect so the always-mounted live region announces it.
  const [deleted, setDeleted] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per arrival
  useEffect(() => {
    if (!fromState) return;
    setDeleted(fromState);
    void navigate({ to: "/templates", replace: true, state: clearedState() });
  }, [fromState]);
  return (
    <>
      <PageHeader
        title="Templates"
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link to="/templates" hash="images">
                Images
              </Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/templates/new">
                <Plus aria-hidden="true" data-icon="inline-start" />
                New template
              </Link>
            </Button>
          </>
        }
      />
      <PageBody>
        <div className="grid gap-4">
          <div role="status" aria-live="polite" className="empty:hidden">
            {deleted && <InlineOutcome tone="success">Deleted {deleted}.</InlineOutcome>}
          </div>
          {isError && !data && (
            <p role="alert" className="text-sm text-muted-foreground">
              Couldn't load templates.
            </p>
          )}
          {data && <TemplateList dir={data.dir} templates={data.templates} />}
          <ImagesSection />
        </div>
      </PageBody>
    </>
  );
}
