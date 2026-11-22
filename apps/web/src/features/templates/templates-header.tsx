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
 *  sr-only below, where the switch takes its place); New template goes icon-only below sm. Below a 17rem
 *  header the switch moves to a second line. */
export function TemplatesHeader({ documentTitle }: { documentTitle?: string }) {
  return (
    <PageHeader
      title="Templates"
      documentTitle={documentTitle}
      titleClassName="@max-[25rem]:sr-only"
      // Below a 17rem header (390px at 200% text) the switch and New template don't fit one line: the switch
      // takes a line of its own instead of covering the button (evidence D4).
      wrap
      meta={
        <SegmentedLinks
          label="Templates views"
          items={VIEWS}
          className="shrink-0 @max-[17rem]:order-last @max-[17rem]:basis-full"
        />
      }
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
