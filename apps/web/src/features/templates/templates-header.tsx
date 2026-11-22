import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const VIEWS = [
  { to: "/templates", label: "Templates" },
  { to: "/templates/images", label: "Images" },
] as const;

/** Spec §14: one header for both views. The h1 stays "Templates" (visible from a 25rem header,
 *  sr-only below, where the switch takes its place); New template goes icon-only below sm. */
export function TemplatesHeader({ documentTitle }: { documentTitle?: string }) {
  return (
    <PageHeader
      title="Templates"
      documentTitle={documentTitle}
      titleClassName="@max-[25rem]:sr-only"
      meta={<SegmentedLinks label="Templates views" items={VIEWS} className="shrink-0" />}
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" asChild>
              <Link to="/templates/new" aria-label="New template">
                <Plus aria-hidden="true" data-icon="inline-start" />
                <span className="max-sm:sr-only">New template</span>
              </Link>
            </Button>
          </TooltipTrigger>
          {/* Only needed while the label is hidden. */}
          <TooltipContent className="sm:hidden">New template</TooltipContent>
        </Tooltip>
      }
    />
  );
}
