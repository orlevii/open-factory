import { type Ref, useState } from "react";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { parsePeekKey } from "./use-peek";

/** STUB (A11): the minimal non-modal sheet the list opens. A12 replaces this file's body with the Skill and Source
 *  peeks; the props stay: the peek key, `onClose`, the content ref (F6 focuses it) and where focus returns. */
export function SkillPeek({
  peekKey,
  onClose,
  contentRef,
  returnFocus,
}: {
  peekKey: string | null;
  onClose(): void;
  contentRef: Ref<HTMLDivElement>;
  returnFocus(key: string): HTMLElement | null;
}) {
  // The last key shown stays while the sheet leaves (the TaskPeek pattern).
  const [shown, setShown] = useState(peekKey);
  if (peekKey !== null && peekKey !== shown) setShown(peekKey);
  return (
    <Sheet
      open={peekKey !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      <SheetContent
        ref={contentRef}
        keepFocus
        aria-describedby={undefined}
        returnFocus={() => (shown ? returnFocus(shown) : null)}
      >
        {shown && (
          <>
            <SheetHeader className="items-center">
              <SheetTitle className="font-mono text-sm font-normal">
                {parsePeekKey(shown)?.id}
              </SheetTitle>
            </SheetHeader>
            <SheetBody key={shown} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
