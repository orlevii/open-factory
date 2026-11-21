import { Link } from "@tanstack/react-router";
import { type Ref, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TaskDetailView } from "./task-detail";

/** A field inside the peek owns Esc (the title edit cancels; the description keeps its draft). */
const FIELD = "input,textarea,[contenteditable]:not([contenteditable=false])";

/**
 * The Tasks list's peek (spec §12): a non-modal sheet opened by Space on a row, focus left on the list.
 * The sheet stays mounted while `taskKey` changes; only the body is keyed, so `j`/`k` swap the task in
 * place and its scroll starts at the top. `null` closes it (the last task stays shown while it leaves).
 */
export function TaskPeek({
  taskKey,
  onClose,
  contentRef,
  returnFocus,
}: {
  taskKey: string | null;
  onClose(): void;
  contentRef: Ref<HTMLDivElement>;
  /** The element to focus on close (the selected row), given the task last shown. */
  returnFocus(key: string): HTMLElement | null;
}) {
  const [shown, setShown] = useState(taskKey);
  if (taskKey !== null && taskKey !== shown) setShown(taskKey);
  return (
    <Sheet
      open={taskKey !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      <SheetContent
        ref={contentRef}
        keepFocus
        aria-describedby={undefined}
        // Radix hears Esc on the document before the editors do: it must not close the peek (and
        // unmount an unsaved draft) from inside a field. The field's own handler still runs.
        onEscapeKeyDown={(e) => {
          if (e.target instanceof Element && e.target.closest(FIELD)) e.preventDefault();
        }}
        returnFocus={() => (shown ? returnFocus(shown) : null)}
      >
        {shown && (
          <>
            <SheetHeader className="items-center">
              <SheetTitle className="font-mono text-sm font-normal">{shown}</SheetTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/tasks/$key" params={{ key: shown }} search={{}}>
                  Open
                </Link>
              </Button>
            </SheetHeader>
            <SheetBody key={shown}>
              <TaskDetailView taskKey={shown} commentId={undefined} />
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
