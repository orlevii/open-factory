import { Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { preloadSheet } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";

/** The Templates header: New template goes icon-only below sm. */
export function TemplatesHeader({ documentTitle }: { documentTitle?: string }) {
  return (
    <PageHeader
      title="Templates"
      documentTitle={documentTitle}
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
