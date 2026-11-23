import type { ReactNode } from "react";
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
