import type { ReactNode } from "react";
import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { type Leave, RepeatsField } from "./repeats-field";

export type WhenMode = "repeats" | "once";

const MODES = [
  { value: "repeats", label: "Repeats" },
  { value: "once", label: "Once" },
] as const;

/**
 * The "When" fieldset (UI design §3): a segmented control, and only the chosen option's field in the DOM
 * (the other's value lives in the form's state, so switching back loses nothing).
 */
export function WhenField({
  mode,
  onMode,
  cron,
  onCron,
  local,
  onLocal,
  errors,
  onBlurCron,
  onPreset,
  onBlurLocal,
  zone,
  preview,
}: {
  mode: WhenMode;
  onMode(m: WhenMode): void;
  cron: string;
  onCron(v: string): void;
  local: string;
  onLocal(v: string): void;
  errors: { cron?: string | undefined; at?: string | undefined };
  onBlurCron: Leave;
  onPreset?(cron: string): void;
  onBlurLocal: Leave;
  zone: string;
  /** The next-runs preview, shown right under the Repeats field. */
  preview?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-3">
      <SegmentedControl
        legend="When"
        legendVisible
        name="when-mode"
        block
        className="max-w-sm"
        value={mode}
        options={MODES}
        onChange={onMode}
      />
      {mode === "repeats" ? (
        <>
          <RepeatsField
            cron={cron}
            onCron={onCron}
            zone={zone}
            error={errors.cron}
            onBlurCron={onBlurCron}
            {...(onPreset ? { onPreset } : {})}
          />
          {preview}
        </>
      ) : (
        <FieldShell name="at" label="Date and time" error={errors.at}>
          {(a) => (
            <Input
              id={a.id}
              name="at"
              type="datetime-local"
              value={local}
              aria-invalid={a.invalid || undefined}
              aria-describedby={a.describedBy}
              className="h-9"
              onChange={(e) => onLocal(e.target.value)}
              onBlur={(e) => onBlurLocal(e)}
            />
          )}
        </FieldShell>
      )}
    </div>
  );
}
