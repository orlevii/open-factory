import type { ReactNode } from "react";
import { FieldNote, noteDescribedBy } from "@/components/field-note";
import { Label } from "@/components/ui/label";

type Props = {
  name: string;
  label: string;
  error?: string;
  /** Muted hint under the field. An error or warning replaces it in the same reserved line. */
  help?: string;
  /** A transient problem: described but not invalid (the value may be fine). */
  warning?: string;
  /** Group of controls: a fieldset with a legend instead of a label for one input. */
  legend?: boolean;
  /** A control at the end of the label row (a ghost "Add credential"); single-input fields only. */
  action?: ReactNode;
  /** Rendered after the note line (a summary under a group). */
  below?: ReactNode;
  /** Extra persistent ids, appended to the visible note's id. */
  describedBy?: string;
  /** The label is for assistive tech only (a heading nearby already names the field). Single-input fields only. */
  hideLabel?: boolean;
  children: (a: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
};

export function FieldShell({
  name,
  label,
  error,
  help,
  warning,
  legend,
  action,
  below,
  describedBy: extra,
  hideLabel,
  children,
}: Props) {
  const id = `field-${name}`;
  const describedBy =
    [noteDescribedBy(id, { help, error, warning }), extra].filter(Boolean).join(" ") || undefined;
  const body = children({ id, describedBy, invalid: Boolean(error) });
  const tail = (
    <>
      <FieldNote id={id} help={help} error={error} warning={warning} />
      {below}
    </>
  );
  if (legend) {
    return (
      <fieldset data-field="" className="grid min-w-0 gap-1.5" aria-describedby={describedBy}>
        <legend className="text-[0.8125rem] font-medium">{label}</legend>
        {body}
        {tail}
      </fieldset>
    );
  }
  const labelEl = (
    <Label htmlFor={id} className={hideLabel ? "sr-only" : "text-[0.8125rem]"}>
      {label}
    </Label>
  );
  return (
    <div data-field="" className="grid min-w-0 gap-1.5">
      {action ? (
        <div className="flex min-h-7 items-center justify-between gap-2">
          {labelEl}
          {action}
        </div>
      ) : (
        labelEl
      )}
      {body}
      {tail}
    </div>
  );
}
