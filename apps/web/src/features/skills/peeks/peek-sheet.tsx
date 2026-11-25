import { type RefObject, useRef, useState } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { parsePeekKey } from "../use-peek";
import { SkillPeekBody } from "./skill-peek";
import { SourcePeekBody } from "./source-peek";
import { usePeekNav } from "./use-peek-nav";

/** The peek of the Skills page (spec §10.3): a non-modal sheet (a drawer below `md`) whose body is the Skill or Source peek.
 *  The sheet stays mounted while the key changes; only the body is keyed, so a retarget swaps it in place with its
 *  scroll at the top. `null` closes it, and the last key stays shown while it leaves. */
export function PeekSheet({
  peekKey,
  show,
  onClose,
  contentRef,
  returnFocus,
}: {
  peekKey: string | null;
  show(key: string): void;
  onClose(): void;
  contentRef: RefObject<HTMLDivElement | null>;
  /** The element to focus on close (the row the peek was opened from). */
  returnFocus(key: string): HTMLElement | null;
}) {
  const [shown, setShown] = useState(peekKey);
  if (peekKey !== null && peekKey !== shown) setShown(peekKey);
  const { back, open, goBack } = usePeekNav(peekKey, show, contentRef);
  // Where focus goes on the next close when it isn't the shown row: a removed source's neighbour header, else (the
  // last source went) the header's Add skills button (spec §10.2). Set from a handler; `undefined` is a plain close.
  const focusInstead = useRef<{ key: string | null } | undefined>(undefined);
  const target = shown ? parsePeekKey(shown) : undefined;
  const onRemoved = (nextKey: string | null) => {
    focusInstead.current = { key: nextKey };
    onClose();
  };
  return (
    <Sheet
      open={peekKey !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      modal={false}
    >
      <SheetContent
        ref={contentRef}
        keepFocus
        aria-describedby={undefined}
        // F6 from the list moved focus in; F6 here moves it back to the shown row (spec §10.2), the peek stays open.
        onKeyDown={(e) => {
          if (e.key !== "F6" || !shown) return;
          e.preventDefault();
          returnFocus(shown)?.focus();
        }}
        returnFocus={() => {
          const instead = focusInstead.current;
          focusInstead.current = undefined;
          if (instead)
            return instead.key !== null
              ? returnFocus(instead.key)
              : document.querySelector<HTMLElement>("[data-add-skills]");
          return shown ? returnFocus(shown) : null;
        }}
      >
        {target?.kind === "skill" ? (
          <SkillPeekBody
            key={shown}
            group={target.id.slice(0, target.id.lastIndexOf("/"))}
            name={target.id.slice(target.id.lastIndexOf("/") + 1)}
            back={back}
            onBack={goBack}
            onOpen={open}
          />
        ) : target?.kind === "source" ? (
          <SourcePeekBody
            key={shown}
            id={target.id}
            back={back}
            onBack={goBack}
            onOpen={open}
            onRemoved={onRemoved}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
