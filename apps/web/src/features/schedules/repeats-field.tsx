import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { instantOnKeyboard } from "@/features/session/quiet-line";
import { describeCron, presetOf, REPEATS_PRESETS } from "./describe-cron";

const CUSTOM = "__custom";

/** A leave; the event's `relatedTarget` lets the form skip a leave toward a `data-skip-validate` control. */
export type Leave = (e?: { relatedTarget: EventTarget | null }) => void;
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
  /** The field was left: the cron input blurred, or the preset list closed or its closed trigger blurred. */
  onBlurCron: Leave;
  /** A preset was chosen (a deliberate pick, so the preview can refresh at once); defaults to onCron. */
  onPreset?(cron: string): void;
}) {
  // Once Custom is chosen it stays, even while the typed cron happens to equal a preset.
  const [custom, setCustom] = useState(() => cron.trim() !== "" && !presetOf(cron));
  const isCustom = custom || (cron.trim() !== "" && !presetOf(cron));
  const preset = presetOf(cron);
  const summary = isCustom ? describeCron(cron) : undefined;
  const [listOpen, setListOpen] = useState(false);
  const opened = useRef(false);
  // Opening a Radix Select moves focus into its list, so the trigger blurs on open: the leave is the list closing,
  // once the pick has rendered (TemplateField's pattern). Picking Custom isn't a leave: focus goes on to the input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list closes
  useEffect(() => {
    if (listOpen || !opened.current) return;
    opened.current = false;
    if (!isCustom) onBlurCron();
  }, [listOpen]);
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
            onOpenChange={(open) => {
              setListOpen(open);
              if (open) opened.current = true;
            }}
          >
            <SelectTrigger
              id={isCustom ? "field-cron-preset" : a.id}
              aria-label="Repeats"
              aria-invalid={(!isCustom && a.invalid) || undefined}
              aria-describedby={isCustom ? undefined : a.describedBy}
              // With Custom chosen the input is the field, so leaving the trigger isn't leaving it.
              onBlur={(e) => !listOpen && !isCustom && onBlurCron(e)}
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
                aria-label="Repeats cron pattern"
                value={cron}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={a.invalid || undefined}
                aria-describedby={a.describedBy}
                className="h-9 font-mono"
                onChange={(e) => onCron(e.target.value)}
                onBlur={(e) => onBlurCron(e)}
              />
              <p
                data-testid="cron-summary"
                className="min-h-[1.125rem] text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
              >
                {summary ? `${summary} (${zone})` : null}
              </p>
              <details className="group text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
                {/* 40px tall on touch; no side padding, so it stays aligned with the field's text (it is wider
                    than 40px). */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: a <summary> is the native disclosure button. */}
                <summary
                  onClick={instantOnKeyboard}
                  className="inline-flex w-fit cursor-pointer list-none items-center gap-1 rounded-md pointer-coarse:min-h-10 [&::-webkit-details-marker]:hidden"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 transition-transform duration-150 ease-(--ease-out) group-open:rotate-90 motion-reduce:transition-none"
                  />
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
