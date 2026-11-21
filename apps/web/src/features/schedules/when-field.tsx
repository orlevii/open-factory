import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";

export type WhenMode = "repeats" | "once";

/**
 * The "When" fieldset (UI design §3): a segmented pair of native radios, and only the chosen option's field in the DOM
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
  const radio = (m: WhenMode, label: string) => (
    <label
      className={`flex h-9 flex-1 cursor-pointer items-center justify-center rounded-md border border-input px-3 text-sm has-[:checked]:bg-sidebar-accent has-[:checked]:font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${mode === m ? "bg-sidebar-accent" : "bg-card"}`}
    >
      <input
        type="radio"
        name="when-mode"
        value={m}
        checked={mode === m}
        onChange={() => onMode(m)}
        className="sr-only"
      />
      {label}
    </label>
  );
  return (
    <fieldset className="grid min-w-0 gap-3">
      <legend className="mb-1.5 text-[0.8125rem] font-medium">When</legend>
      <div className="flex max-w-sm gap-2">
        {radio("repeats", "Repeats")}
        {radio("once", "Once")}
      </div>
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
              className="h-9 bg-card font-mono dark:bg-card"
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
    </fieldset>
  );
}
