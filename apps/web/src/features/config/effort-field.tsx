import { EFFORTS } from "@open-factory/shared";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CONFIG_COPY } from "./messages";
import { useFieldNote } from "./scope";
import { OverrideAction, WrongType } from "./section";
import { readString } from "./tolerant";
import { INHERIT, useScalar } from "./use-scalar";

const KNOWN: ReadonlySet<string> = new Set<string>(EFFORTS);

/** Effort (spec §12.3): inherit (or Claude Code default), then today's efforts. */
export function EffortField() {
  const { scope, own, inherited, inherits, overridden, set } = useScalar("effort");
  const note = useFieldNote("effort");
  const trigger = useRef<HTMLButtonElement>(null);
  const r = readString(own);
  // An effort the picker can't show (a typo in Raw JSON) is edited there.
  if (!r.ok || (r.value !== undefined && !KNOWN.has(r.value)))
    return <WrongType field="effort" label="Effort" />;
  const help = inherits
    ? `From template: ${typeof inherited === "string" ? inherited : CONFIG_COPY.inheritTemplate}`
    : undefined;

  const inheritAgain = () => {
    flushSync(() => set(undefined));
    trigger.current?.focus();
  };

  return (
    <FieldShell
      name="effort"
      label="Effort"
      help={help}
      error={note.error}
      warning={note.warning}
      action={
        overridden && !scope.readOnly ? (
          <OverrideAction what="effort" onUse={inheritAgain} />
        ) : undefined
      }
    >
      {({ id, describedBy, invalid }) => (
        <Select
          value={r.value ?? INHERIT}
          onValueChange={(v) => set(v === INHERIT ? undefined : v)}
          disabled={scope.readOnly}
        >
          <SelectTrigger
            ref={trigger}
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {scope.mode === "agent" ? CONFIG_COPY.inheritAgent : CONFIG_COPY.inheritTemplate}
            </SelectItem>
            {EFFORTS.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FieldShell>
  );
}
