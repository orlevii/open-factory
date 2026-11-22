import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { preloadSheet } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";

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
            <Button
              variant="ghost"
              aria-label="New template"
              // biome-ignore lint/suspicious/noThenProperty: SheetSpec's field, not a thenable
              onClick={() => openSheet({ kind: "new-template", then: "open-editor" })}
              onPointerEnter={() => preloadSheet("new-template")}
              onFocus={() => preloadSheet("new-template")}
            >
              <Plus aria-hidden="true" data-icon="inline-start" />
              <span className="max-sm:sr-only">New template</span>
            </Button>
          </TooltipTrigger>
          {/* Only needed while the label is hidden. */}
          <TooltipContent className="sm:hidden">New template</TooltipContent>
        </Tooltip>
      }
    />
  );
}
