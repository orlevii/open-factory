import { type ReactElement, type ReactNode, useMemo, useRef, useState } from "react";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import type { AddSlot } from "./config-list";

/**
 * A list's add control when its items come from data (skills, secrets, templates): a Combobox whose pick adds the
 * value through the list's own add, so duplicates and checks behave as typed adds do. `extra` sits beside it.
 */
export function PickAdd({
  slot,
  label,
  placeholder,
  options,
  emptyText,
  renderOption,
  extra,
}: {
  slot: AddSlot;
  /** "Add skill": the trigger's and the listbox's name. */
  label: string;
  placeholder: string;
  options: ComboOption[];
  emptyText: string;
  renderOption?: (o: ComboOption) => ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1 basis-56">
        <Combobox
          id={slot.id}
          value=""
          onValueChange={slot.add}
          options={options}
          placeholder={placeholder}
          emptyText={emptyText}
          aria-label={label}
          aria-describedby={slot.describedBy}
          aria-invalid={slot.invalid || undefined}
          renderOption={renderOption}
        />
      </div>
      {extra}
    </div>
  );
}

/** The empty text of a picker over a query: loading, failed, or nothing left to add. */
export const pickEmpty = (q: { isPending: boolean; isError: boolean }, none: string): string =>
  q.isError ? "Couldn't load the list." : q.isPending ? "Loading…" : none;

/**
 * A list's multi-pick add (skills): a caller trigger opens a Combobox that stays open across picks. A pick adds
 * through the list's own add without scrolling the page; the last added row scrolls into view once the popover
 * closes. "Added <name>" is announced from a polite live region next to the trigger, outside the popover, so it
 * survives the close.
 */
export function PickAddMany({
  slot,
  label,
  options,
  emptyText,
  renderOption,
  renderGroup,
  groupRows,
  footer,
  picked,
  trigger,
  onPick,
  refusalExtra,
}: {
  slot: AddSlot;
  label: string;
  options: ComboOption[];
  emptyText: string;
  renderOption?: (o: ComboOption) => ReactNode;
  renderGroup?: (group: string) => ReactNode;
  /** Each group opens with a row that adds all of it in one pick; options show checkboxes. */
  groupRows?: boolean;
  footer?: ReactNode;
  /** Every name already in the list (this agent's and the template's). */
  picked: readonly string[];
  trigger: ReactElement;
  /** A rule a pick must pass: a refusal message (shown in the footer and announced) stops the add. Stable. */
  onPick?: (value: string) => string | undefined;
  /**
   * What sits under a refusal (an action that gets past it). `accept` is called once the caller has added the value
   * itself: it clears the refusal and marks the value as the one to reveal on close.
   */
  refusalExtra?: (value: string, accept: () => void) => ReactNode;
}) {
  // `picked` may be a fresh array each render (the draft is read tolerantly): its joined names are the key.
  const key = picked.join("\0");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the primitive form of `picked`
  const added = useMemo(() => new Set(picked), [key]);
  const [said, setSaid] = useState("");
  const [refused, setRefused] = useState("");
  const [refusedValue, setRefusedValue] = useState("");
  // With group rows the boxes untick: picking an added skill again removes it from the list.
  const remove = groupRows ? slot.remove : undefined;
  const multiple = useMemo(
    () => ({ added, announce: setSaid, groupRows, remove }),
    [added, groupRows, remove],
  );
  const last = useRef<string>(undefined);
  return (
    <>
      <Combobox
        value=""
        onValueChange={(v) => {
          const why = onPick?.(v);
          setRefused(why ?? "");
          setRefusedValue(why ? v : "");
          if (why) {
            setSaid(why);
            return;
          }
          last.current = v;
          slot.add(v, { scroll: false });
        }}
        options={options}
        emptyText={emptyText}
        aria-label={label}
        renderOption={renderOption}
        renderGroup={renderGroup}
        footer={
          refused ? (
            <>
              {footer}
              <p className="border-t border-border px-3 py-2 text-xs text-foreground">{refused}</p>
              {refusalExtra?.(refusedValue, () => {
                last.current = refusedValue;
                setRefused("");
                setRefusedValue("");
                setSaid(`Added ${refusedValue}`);
              })}
            </>
          ) : (
            footer
          )
        }
        multiple={multiple}
        trigger={trigger}
        onOpen={() => {
          setSaid("");
          setRefused("");
        }}
        onClose={() => {
          if (last.current !== undefined) slot.reveal(last.current);
          last.current = undefined;
        }}
      />
      <span role="status" className="sr-only">
        {said}
      </span>
    </>
  );
}
