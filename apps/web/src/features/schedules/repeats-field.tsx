import { useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { IN_FORM } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeCron, presetOf, REPEATS_PRESETS } from "./describe-cron";

const CUSTOM = "__custom";
const CRON_HELP =
  "A 5-field cron expression: minute hour day-of-month month day-of-week. Examples: 0 9 * * 1-5 (weekdays at 09:00), */30 * * * * (every 30 minutes), 0 8 1 * * (the 1st of each month at 08:00).";

/**
 * The Repeats field (§9.3): a Select of presets, and "Custom cron…" for the cron input with its help and a plain-words
 * summary. A preset shows nothing more. A cron that matches no preset opens on Custom.
 */
export function RepeatsField({
  cron,
  onCron,
  zone,
  error,
  onBlurCron,
  onPreset,
}: {
  cron: string;
  onCron(v: string): void;
  zone: string;
  error: string | undefined;
  onBlurCron(): void;
  /** A preset was chosen (a deliberate pick, so the preview can refresh at once); defaults to onCron. */
  onPreset?(cron: string): void;
}) {
  // Once Custom is chosen it stays, even while the typed cron happens to equal a preset.
  const [custom, setCustom] = useState(() => cron.trim() !== "" && !presetOf(cron));
  const isCustom = custom || (cron.trim() !== "" && !presetOf(cron));
  const preset = presetOf(cron);
  const summary = isCustom ? describeCron(cron) : undefined;
  return (
    <FieldShell name="cron" label="Repeats" error={error}>
      {(a) => (
        <div className="grid gap-1.5">
          <Select
            value={
              isCustom ? CUSTOM : (REPEATS_PRESETS.find((p) => p.label === preset)?.label ?? "")
            }
            onValueChange={(v) => {
              if (v === CUSTOM) return setCustom(true);
              setCustom(false);
              (onPreset ?? onCron)(REPEATS_PRESETS.find((p) => p.label === v)?.cron ?? "");
            }}
          >
            <SelectTrigger
              id={isCustom ? "field-cron-preset" : a.id}
              aria-label="Repeats"
              aria-invalid={(!isCustom && a.invalid) || undefined}
              aria-describedby={isCustom ? undefined : a.describedBy}
            >
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              {REPEATS_PRESETS.map((p) => (
                <SelectItem key={p.label} value={p.label}>
                  {p.label}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM}>Custom cron…</SelectItem>
            </SelectContent>
          </Select>
          {isCustom && (
            <>
              <Input
                id={a.id}
                name="cron"
                aria-label="Cron pattern"
                value={cron}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={a.invalid || undefined}
                aria-describedby={a.describedBy}
                className="h-9 font-mono"
                onChange={(e) => onCron(e.target.value)}
                onBlur={onBlurCron}
              />
              <p
                data-testid="cron-summary"
                className="min-h-[1.125rem] text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
              >
                {summary ? `${summary} (${zone})` : null}
              </p>
              <details className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
                <summary
                  className={`w-fit cursor-pointer pointer-coarse:content-center ${IN_FORM}`}
                >
                  Cron help
                </summary>
                <p className="mt-1">{CRON_HELP}</p>
              </details>
            </>
          )}
        </div>
      )}
    </FieldShell>
  );
}
