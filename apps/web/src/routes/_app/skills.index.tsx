import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { PageBody } from "@/components/page-header";
import { closeInstantly } from "@/components/ui/sheet";
import { openSheet } from "@/features/sheets/sheet-store";
import { PeekSheet } from "@/features/skills/peeks/peek-sheet";
import { SkillList } from "@/features/skills/skill-list";
import { SkillsHeader } from "@/features/skills/skills-header";
import { SKILLS_ARRIVAL, useLibraryArrival } from "@/features/skills/use-library-arrival";
import { type PeekControl, usePeek } from "@/features/skills/use-peek";

export const Route = createFileRoute("/_app/skills/")({ component: SkillsPage });

/** The row a peek shows, where focus returns when it closes. */
const findRow = (key: string) =>
  document.querySelector<HTMLElement>(`[data-peek-key="${CSS.escape(key)}"]`);

function SkillsPage() {
  const { key, show, close } = usePeek();
  const content = useRef<HTMLDivElement>(null);
  // The arrival's peek is set while this component renders, so `show` must be this component's own state setter.
  const { arrivedKey, arrival, onArrivedEnd } = useLibraryArrival(show, SKILLS_ARRIVAL);
  const peek: PeekControl = {
    key,
    show,
    close: () => closeInstantly(content.current, close),
    focus: () => content.current?.focus(),
  };
  return (
    <>
      <SkillsHeader view="skills" onAdd={() => openSheet({ kind: "add-skills" })} />
      <PageBody>
        {/* At 54rem of container the list keeps 30rem clear of an open peek. */}
        <div className="@container">
          <div
            data-open={key !== null ? "" : undefined}
            className="@[54rem]:data-[open]:pr-[30rem]"
          >
            <SkillList
              peek={peek}
              arrivedKey={arrivedKey}
              arrival={arrival}
              onArrivedEnd={onArrivedEnd}
            />
          </div>
        </div>
      </PageBody>
      <PeekSheet
        peekKey={key}
        show={show}
        onClose={close}
        contentRef={content}
        returnFocus={findRow}
      />
    </>
  );
}
