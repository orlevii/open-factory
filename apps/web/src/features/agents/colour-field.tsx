import { AVATAR_HUES } from "@open-factory/shared";
import { type KeyboardEvent, type MouseEvent, memo, useRef } from "react";
import { AgentAvatar, partsFor } from "@/components/agent-avatar";
import { FieldShell } from "@/components/field-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The line that replaces the field when the template's avatar.svg sets the avatar (spec §12.6, verbatim; a muted line, not a field message, so the 40-character rule doesn't apply). */
export const COLOUR_MSG = {
  templateAvatar: "This template's avatar.svg sets the avatar.",
} as const;

type Option = { value: number | null; name: string };
/** Auto first, then the twelve hues: one list serves rendering, arrow keys, Home and End. */
const OPTIONS: readonly Option[] = [
  { value: null, name: "Auto" },
  ...AVATAR_HUES.map((h) => ({ value: h.index, name: h.name })),
];
const AUTO = OPTIONS[0] as Option;
const HUES = OPTIONS.slice(1);
const HUE_NAME = new Map(AVATAR_HUES.map((h) => [h.index, h.name]));

/** "Teal", or "Auto (Jade)": the legend row always names what the avatar will wear. */
export function colourName(value: number | null, agentRef: string): string {
  return value === null
    ? `Auto (${HUE_NAME.get(partsFor(agentRef).fill) ?? ""})`
    : (HUE_NAME.get(value) ?? "");
}

const SWATCH =
  "relative grid size-8 place-items-center rounded-md focus-visible:outline-offset-4 pointer-coarse:size-10";

const Swatch = memo(function Swatch({
  option,
  agentRef,
  checked,
}: {
  option: Option;
  agentRef: string;
  checked: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: a swatch is a button face, not a native radio */}
        <button
          type="button"
          role="radio"
          aria-checked={checked}
          aria-label={option.name}
          tabIndex={checked ? 0 : -1}
          data-value={option.value ?? ""}
          className={cn(
            SWATCH,
            option.value === null && "border border-dashed border-input",
            checked && "ring-2 ring-foreground ring-offset-2 ring-offset-popover",
          )}
        >
          <AgentAvatar agentRef={agentRef} color={option.value} size={24} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{option.name}</TooltipContent>
    </Tooltip>
  );
});

/**
 * The agent's identity colour (spec §12.6): a radiogroup of avatar-faced swatches. The group owns click and key
 * handling by delegation, so the memoised swatches take no callbacks; an arrow key moves and selects.
 */
export function ColourField({
  agentRef,
  value,
  onChange,
  avatarVersion,
  error,
}: {
  agentRef: string;
  value: number | null;
  onChange: (value: number | null) => void;
  /** The agent's avatar version: set when the template's avatar.svg wins, and then there is no choice to make. */
  avatarVersion?: string | null;
  error?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  if (avatarVersion)
    return <p className="text-[0.8125rem] text-muted-foreground">{COLOUR_MSG.templateAvatar}</p>;

  const hueAt = (el: Element | null) => {
    const raw = el?.closest<HTMLElement>("[data-value]")?.dataset.value;
    return raw === undefined ? undefined : raw === "" ? null : Number(raw);
  };
  const onClick = (e: MouseEvent) => {
    const v = hueAt(e.target as Element);
    if (v !== undefined) onChange(v);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = OPTIONS.findIndex((o) => o.value === value);
    const last = OPTIONS.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (at + 1) % OPTIONS.length
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (at + last) % OPTIONS.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange((OPTIONS[next] as Option).value);
    group.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  };

  return (
    <FieldShell name="color" legend label={`Colour · ${colourName(value, agentRef)}`} error={error}>
      {() => (
        <div
          ref={group}
          role="radiogroup"
          aria-labelledby="field-color-legend"
          className="flex items-center gap-2"
          onClick={onClick}
          onKeyDown={onKeyDown}
        >
          <Swatch option={AUTO} agentRef={agentRef} checked={value === null} />
          <div className="grid grid-cols-6 gap-0">
            {HUES.map((o) => (
              <Swatch key={o.value} option={o} agentRef={agentRef} checked={value === o.value} />
            ))}
          </div>
        </div>
      )}
    </FieldShell>
  );
}
