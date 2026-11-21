import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";

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
  onBlurLocal,
}: {
  mode: WhenMode;
  onMode(m: WhenMode): void;
  cron: string;
  onCron(v: string): void;
  local: string;
  onLocal(v: string): void;
  errors: { cron?: string | undefined; at?: string | undefined };
  onBlurCron(): void;
  onBlurLocal(): void;
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
        <FieldShell
          name="cron"
          label="Repeats"
          error={errors.cron}
          help="A 5-field cron expression: minute hour day-of-month month day-of-week. Examples: 0 9 * * 1-5 (weekdays at 09:00), */30 * * * * (every 30 minutes), 0 8 1 * * (the 1st of each month at 08:00)."
        >
          {(a) => (
            <Input
              id={a.id}
              name="cron"
              value={cron}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={a.invalid || undefined}
              aria-describedby={a.describedBy}
              className="h-9 font-mono"
              onChange={(e) => onCron(e.target.value)}
              onBlur={onBlurCron}
            />
          )}
        </FieldShell>
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
              onBlur={onBlurLocal}
            />
          )}
        </FieldShell>
      )}
    </div>
  );
}
