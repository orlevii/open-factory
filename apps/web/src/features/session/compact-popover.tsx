import { ApiError } from "@open-factory/shared";
import { CircleAlert, Minimize2 } from "lucide-react";
import { type RefObject, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { postCompact } from "./api";
import { NETWORK_ERROR } from "./composer";

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
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const inputId = useId();

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await postCompact(slug, focus.trim() || undefined);
      setFocus("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(undefined);
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
        // No PopoverTrigger when anchored, so Radix has nothing to return focus to: send it to the anchor.
        onCloseAutoFocus={
          anchor
            ? (e) => {
                e.preventDefault();
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
          <label htmlFor={inputId} className="text-[0.8125rem] font-medium">
            Focus (optional)
          </label>
          <Input
            id={inputId}
            autoFocus
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            maxLength={2000}
          />
          {error && (
            <p
              role="alert"
              className="flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-destructive"
            >
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={submitting}>
            Compact
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
