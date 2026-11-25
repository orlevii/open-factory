import type { ReactNode } from "react";
import { useRef } from "react";
import { PageBody } from "@/components/page-header";
import { closeInstantly } from "@/components/ui/sheet";
import type { Arrival } from "@/lib/use-arrival";
import { PeekSheet } from "./peeks/peek-sheet";
import { SkillsHeader, type SkillsView } from "./skills-header";
import { type ArrivalView, useLibraryArrival } from "./use-library-arrival";
import { type PeekControl, usePeek } from "./use-peek";

/** The row a peek shows, where focus returns when it closes. */
const findRow = (key: string) =>
  document.querySelector<HTMLElement>(`[data-peek-key="${CSS.escape(key)}"]`);

/**
 * A Skills view with a list and its peek (spec §10.2): the header, the list with 30rem kept clear at 54rem of container
 * while a peek is open, and the peek sheet. The Plugins and Marketplaces routes are this with their list. The arrival's
 * peek is set while this component renders, so `show` is this component's own state setter.
 */
export function PeekPage<T>({
  view,
  arrivalView,
  onAdd,
  list,
}: {
  view: SkillsView;
  arrivalView: ArrivalView<T>;
  onAdd?(): void;
  list(p: {
    peek: PeekControl;
    arrivedKey: string | undefined;
    arrival: Arrival | undefined;
    onArrivedEnd(): void;
  }): ReactNode;
}) {
  const { key, show, close } = usePeek();
  const content = useRef<HTMLDivElement>(null);
  const { arrivedKey, arrival, onArrivedEnd } = useLibraryArrival(show, arrivalView);
  const peek: PeekControl = {
    key,
    show,
    close: () => closeInstantly(content.current, close),
    focus: () => content.current?.focus(),
  };
  return (
    <>
      <SkillsHeader view={view} onAdd={onAdd} />
      <PageBody>
        <div className="@container">
          <div
            data-open={key !== null ? "" : undefined}
            className="@[54rem]:data-[open]:pr-[30rem]"
          >
            {list({ peek, arrivedKey, arrival, onArrivedEnd })}
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
