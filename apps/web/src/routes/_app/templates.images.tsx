import { createFileRoute } from "@tanstack/react-router";
import { PageBody } from "@/components/page-header";
import { ImagesSection } from "@/features/templates/images-section";
import { TemplatesHeader } from "@/features/templates/templates-header";

export const Route = createFileRoute("/_app/templates/images")({ component: ImagesPage });

function ImagesPage() {
  return (
    <>
      <TemplatesHeader documentTitle="Images" />
      <PageBody>
        <ImagesSection />
      </PageBody>
    </>
  );
}
