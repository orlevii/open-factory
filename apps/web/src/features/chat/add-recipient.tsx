import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { memo, useMemo } from "react";
import { PHONE_ICON } from "@/components/composer/composer";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboOption } from "@/components/ui/combobox";
import { principalsQueryOptions } from "@/features/principals/api";
import { useIsMobile } from "@/hooks/use-mobile";
import { MAX_RECIPIENTS } from "@/lib/drafts";
import { cn } from "@/lib/utils";

export const FULL_NOTE = `A message goes to at most ${MAX_RECIPIENTS} agents.`;
const FOOTER = (
  <p className="px-3 py-2 text-xs text-muted-foreground">
    Only live agents get messages · Up to {MAX_RECIPIENTS} per message
  </p>
);
// Each addition is announced by the composer's "Also sending to @x" region; the picker stays silent.
const SILENT = () => {};

function renderOption(o: ComboOption) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate">{o.label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{o.keywords?.[0]}</span>
    </span>
  );
}

/**
 * "Add recipient" (I1 §6.6): a multi-pick of the live agents, without the chat's own, that stays open
 * after each pick. `held` is why adding can't happen now (ten agents, or files attached): the button
 * stays focusable with `aria-disabled`, and pressing it hands the reason to `onHeld` instead of opening.
 * `compact` is the "Add" at the end of the chips; the toolbar one is an icon below `md`.
 */
export const AddRecipient = memo(function AddRecipient({
  agentRef,
  recipients,
  held,
  onAdd,
  onHeld,
  compact = false,
}: {
  /** The chat's agent (its ref): never offered. */
  agentRef: string;
  /** Refs already added. */
  recipients: readonly string[];
  /** Why adding is held now, if it is. */
  held: string | undefined;
  onAdd(ref: string): void;
  onHeld(reason: string): void;
  compact?: boolean;
}) {
  const phone = useIsMobile();
  const { data } = useQuery(principalsQueryOptions);
  const full = recipients.length + 1 >= MAX_RECIPIENTS;
  const options = useMemo<ComboOption[]>(
    () =>
      [...(data?.byRef.values() ?? [])]
        .filter((p) => p.kind === "agent" && p.state === "live" && p.ref !== agentRef)
        .map((p) => ({
          value: p.ref,
          label: p.name,
          keywords: [`@${p.handle}`],
          disabled: full,
        })),
    [data, agentRef, full],
  );
  const added = useMemo(() => new Set(recipients), [recipients]);
  const pick = (ref: string) => {
    if (full || added.has(ref)) return;
    onAdd(ref);
  };
  const label = compact ? "Add" : "Add recipient";
  const icon = !compact && phone;
  return (
    <Combobox
      value=""
      onValueChange={pick}
      options={options}
      aria-label="Add recipient"
      emptyText="No other live agents"
      renderOption={renderOption}
      footer={FOOTER}
      multiple={{ added, announce: SILENT }}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size={compact ? "xs" : icon ? "icon" : "sm"}
          aria-label={icon ? "Add recipient" : undefined}
          aria-disabled={held !== undefined || undefined}
          className={cn("shrink-0 text-muted-foreground", icon && PHONE_ICON)}
          onClick={(e) => {
            if (held === undefined) return;
            e.preventDefault(); // the popover's own toggle sees a handled press
            onHeld(held);
          }}
        >
          <UserPlus aria-hidden="true" />
          {icon ? null : label}
        </Button>
      }
    />
  );
});
