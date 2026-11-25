import { type ReactNode, useId } from "react";
import { FieldShell } from "@/components/field-shell";
import { Button } from "@/components/ui/button";
import type { ConfigField } from "./fields";
import { fieldPath } from "./fields";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";
import { useConfigScope } from "./scope";

/** One form section (spec §12.2): an h2, then its fields in an I4 `field-stack`. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <h2 id={id} className="text-[0.9375rem] font-medium">
        {title}
      </h2>
      <div className="field-stack">{children}</div>
    </section>
  );
}

/** "Show in Raw JSON" for a field: a ghost link-sized button, only when the page has a Raw tab. */
export function ShowInRaw({ path, describedBy }: { path?: string; describedBy?: string }) {
  const { onShowRaw } = useConfigScope();
  if (!onShowRaw) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="justify-self-start"
      aria-describedby={describedBy}
      onClick={() => onShowRaw({ path })}
    >
      {CONFIG_COPY.showInRaw}
    </Button>
  );
}

/** A field whose value has the wrong type (Raw JSON made it): the note and a jump, never a control that would throw. */
export function WrongType({ field, label }: { field: ConfigField; label: string }) {
  return (
    <FieldShell
      name={field}
      label={label}
      plainLabel
      error={CONFIG_FIELD_MSG.editInRaw}
      below={<ShowInRaw path={fieldPath(field)} describedBy={`field-${field}-error`} />}
    >
      {() => null}
    </FieldShell>
  );
}

/** An overridden scalar's label-row action (spec §12.3): "This agent" and a ghost "Use template's". */
export function OverrideAction({ what, onUse }: { what: string; onUse: () => void }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-[0.8125rem] text-muted-foreground">{CONFIG_COPY.thisAgent}</span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={`${CONFIG_COPY.useTemplates} ${what}`}
        onClick={onUse}
      >
        {CONFIG_COPY.useTemplates}
      </Button>
    </span>
  );
}
