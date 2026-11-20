import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

type Props = {
  name: string;
  label: string;
  error?: ReactNode;
  /** Muted hint under the field. An error replaces it in the same slot. */
  help?: string;
  /** Group of controls: a fieldset with a legend instead of a label for one input. */
  legend?: boolean;
  children: (a: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
};

export function FieldShell({ name, label, error, help, legend, children }: Props) {
  const id = `field-${name}`;
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  // Exactly one description: the error when there is one, else the help text.
  const describedBy = error ? errorId : help ? helpId : undefined;
  const body = children({ id, describedBy, invalid: Boolean(error) });
  const note = error ? (
    <p
      id={errorId}
      className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {error}
    </p>
  ) : (
    help && (
      <p id={helpId} className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
        {help}
      </p>
    )
  );
  if (legend) {
    return (
      <fieldset className="grid min-w-0 gap-1.5" aria-describedby={describedBy}>
        <legend className="text-[0.8125rem] font-medium">{label}</legend>
        {body}
        {note}
      </fieldset>
    );
  }
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-[0.8125rem]">
        {label}
      </Label>
      {body}
      {note}
    </div>
  );
}
