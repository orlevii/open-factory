import { useRef } from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import { useFieldNote } from "./scope";
import { OverrideAction, WrongType } from "./section";
import { readNumber } from "./tolerant";
import { useScalar } from "./use-scalar";

const DIGITS = /^\d+$/;

/**
 * A whole-number setting (spec §12.3): the placeholder is the inherited value and empty means inherit. Only digits
 * are taken, so the draft always holds a number or nothing; the range is checked when the field is left.
 */
export function NumberField({
  field,
  label,
  unit,
  fallback,
}: {
  field: "warmWindow" | "maxLiveSpawns";
  label: string;
  /** "minutes": the help reads "From template: 70 minutes". */
  unit?: string;
  /** What applies when nothing sets it (the factory default), for the placeholder and help. */
  fallback?: number;
}) {
  const { scope, own, inherited, inherits, overridden, set } = useScalar(field);
  const note = useFieldNote(field);
  const input = useRef<HTMLInputElement>(null);
  const r = readNumber(own);
  if (!r.ok) return <WrongType field={field} label={label} />;
  const shown = typeof inherited === "number" ? inherited : fallback;
  const help =
    inherits && shown !== undefined
      ? `From template: ${shown}${unit ? ` ${unit}` : ""}`
      : undefined;
  const { fieldErrors } = scope;

  const inheritAgain = () => {
    fieldErrors.change(field);
    flushSync(() => set(undefined));
    input.current?.focus();
  };

  return (
    <FieldShell
      name={field}
      label={label}
      help={help}
      error={note.error}
      warning={note.warning}
      action={
        overridden && !scope.readOnly ? (
          <OverrideAction what={label.toLowerCase()} onUse={inheritAgain} />
        ) : undefined
      }
    >
      {({ id, describedBy, invalid }) => (
        <Input
          ref={input}
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={r.value === undefined ? "" : String(r.value)}
          placeholder={shown === undefined ? undefined : String(shown)}
          readOnly={scope.readOnly}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className="max-w-40"
          onChange={(e) => {
            const t = e.target.value.trim();
            if (t !== "" && !DIGITS.test(t)) return;
            fieldErrors.change(field);
            set(t === "" ? undefined : Number(t));
          }}
          onBlur={(e) => fieldErrors.blur(field, e)}
        />
      )}
    </FieldShell>
  );
}
