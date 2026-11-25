import { Dialog as DialogPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useLatchedMobile } from "@/hooks/use-latched-mobile";
import { useStampedRef } from "@/lib/input-modality";
import { cn } from "@/lib/utils";

/**
 * A form opened from a page for one item (DESIGN.md → Overlays): a modal dialog, a bottom drawer below `md`, decided
 * once per opening. It is anchored at a fixed top so it never jumps as fields come and go, scrolls its body under a
 * fixed footer, and dismisses (Esc, scrim, Cancel) without asking: the caller keeps the draft. `primary` is the one
 * primary button; Cancel is ghost beside it on the dialog, and last, full width, on the drawer.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  children,
  primary,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
  primary: ReactNode;
  /** Dialog only: the drawer takes focus itself, so the iOS keyboard doesn't rise mid-slide. */
  onOpenAutoFocus?: (e: Event) => void;
  /** Where focus goes on close (the row the dialog was about). */
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const mobile = useLatchedMobile(open);
  const cancel = (
    <Button type="button" variant="ghost" inForm onClick={() => onOpenChange(false)}>
      Cancel
    </Button>
  );
  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          data-slot="form-dialog"
        >
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
          </DrawerHeader>
          <DrawerBody>{children}</DrawerBody>
          <DrawerFooter>
            {primary}
            {cancel}
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <div className="border-b px-4 py-3">
            <DialogPrimitive.Title className="font-heading text-base leading-5 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere]">
              {title}
            </DialogPrimitive.Title>
          </div>
          <div className="@container min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            {cancel}
            {primary}
          </div>
        </DialogContent>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** 150ms in, a 100ms fade out (DESIGN.md → Motion → Durations). Stamped per opening, so a keyboard open is instant. */
function DialogOverlay({ ref, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  const stamped = useStampedRef(ref);
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      ref={stamped}
      className="fixed inset-0 z-50 bg-black/20 duration-150 ease-(--ease-out) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-100 dark:bg-black/40"
      {...props}
    />
  );
}

/** Top-anchored at ~12svh with its origin at the top centre; enters from 96% (scale `motion-safe` only), leaves with a fade. */
function DialogContent({
  className,
  ref,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  const stamped = useStampedRef(ref);
  return (
    <DialogPrimitive.Content
      data-slot="dialog-content"
      ref={stamped}
      className={cn(
        "fixed top-[12svh] left-1/2 z-50 flex max-h-[calc(100svh-12svh-1rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 origin-top flex-col rounded-lg border border-float-edge bg-popover text-sm text-popover-foreground outline-none sm:max-w-xl", // ui-contract:allow dialog surface takes focus programmatically
        "duration-150 ease-(--ease-out) data-open:animate-in data-open:fade-in-0 motion-safe:data-open:zoom-in-[0.96] data-closed:animate-out data-closed:fade-out-0 data-closed:duration-100",
        className,
      )}
      {...props}
    />
  );
}
