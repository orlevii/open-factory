import { ApiError } from "@open-factory/shared";
import { Minimize2 } from "lucide-react";
import { type RefObject, useState } from "react";
import { FormField } from "@/components/form-field";
import { FormOutcome, useOutcome } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { postCompact } from "./api";

/** No confirmation: Compact queues behind the current turn and the timeline shows it (UI §6). */
export function CompactPopover({
  slug,
  open: controlledOpen,
  onOpenChange,
  anchor,
}: {
  slug: string;
  /** Controlled open state; the agent menu's Compact item sets it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** With an anchor (the menu's ⋯ button) there is no trigger of its own: the popover opens from it. */
  anchor?: RefObject<HTMLElement | null>;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (o: boolean) => {
    setOwnOpen(o);
    onOpenChange?.(o);
  };
  const [focus, setFocus] = useState("");
  const { outcome, fail, clear } = useOutcome();
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    clear();
    try {
      await postCompact(slug, focus.trim() || undefined);
      setFocus("");
      setOpen(false);
    } catch (e) {
      fail(e instanceof ApiError ? e.message : FORM_MSG.unreachable);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) clear();
      }}
    >
      {anchor ? (
        <PopoverAnchor virtualRef={anchor} />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant="ghost">
                <Minimize2 aria-hidden="true" />
                <span className="max-md:sr-only">Compact</span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent className="md:hidden">Compact</TooltipContent>
        </Tooltip>
      )}
      <PopoverContent
        align="end"
        className="w-72"
        // No PopoverTrigger when anchored, so Radix has nothing to return focus to: send it to the
        // anchor, unless something already took it (the read-only line, when the agent was
        // terminated while it was open).
        onCloseAutoFocus={
          anchor
            ? (e) => {
                e.preventDefault();
                const at = document.activeElement;
                if (at && at !== document.body && at.isConnected) return;
                anchor.current?.focus();
              }
            : undefined
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-2"
        >
          <FormField
            name="compact-focus"
            label="Focus (optional)"
            autoFocus
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            maxLength={2000}
          />
          <FormOutcome outcome={outcome} pending={submitting ? "Compacting…" : undefined} />
          <Button type="submit" className="w-full" disabled={submitting}>
            Compact
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
