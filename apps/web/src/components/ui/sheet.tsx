import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useLatchedMobile } from "@/hooks/use-latched-mobile";
import { stampInstant, useStampedRef } from "@/lib/input-modality";
import { cn } from "@/lib/utils";

const SheetCtx = React.createContext<{ mobile: boolean }>({ mobile: false });
const useMobile = () => React.useContext(SheetCtx).mobile;

/** One sheet for create/edit forms and peeks (DESIGN.md → Overlays): a 480px right panel on desktop, a
 *  bottom drawer below md. The choice is made per opening (spec §5.1). Dismissing never asks. */
function Sheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: React.ReactNode;
}) {
  const mobile = useLatchedMobile(open);
  const ctx = React.useMemo(() => ({ mobile }), [mobile]);
  return (
    <SheetCtx.Provider value={ctx}>
      {mobile ? (
        <Drawer open={open} onOpenChange={onOpenChange} direction="bottom">
          {children}
        </Drawer>
      ) : (
        <SheetPrimitive.Root data-slot="sheet" open={open} onOpenChange={onOpenChange}>
          {children}
        </SheetPrimitive.Root>
      )}
    </SheetCtx.Provider>
  );
}

/** Travels 100% of its width with no panel fade; under reduced motion it fades instead (the global
 *  reduced-motion rule zeroes the slide). No shadow: the scrim and the edge rule separate it. */
function SheetContent({ className, children, ref, ...props }: React.ComponentProps<typeof SheetPrimitive.Content>) {
  const mobile = useMobile();
  const stampedRef = useStampedRef(ref);
  if (mobile) {
    return (
      <DrawerContent ref={ref} className={className} {...props}>
        {children}
      </DrawerContent>
    );
  }
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        data-slot="sheet-overlay"
        ref={stampInstant}
        className="fixed inset-0 z-50 bg-black/20 duration-250 ease-(--ease-drawer) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-200 data-closed:ease-(--ease-out) dark:bg-black/40"
      />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        ref={stampedRef}
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-[min(30rem,100%)] flex-col border-l border-float-edge bg-popover text-sm text-popover-foreground",
          "duration-250 ease-(--ease-drawer) data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right data-closed:duration-200 data-closed:ease-(--ease-out)",
          "motion-reduce:data-open:fade-in-0 motion-reduce:data-closed:fade-out-0",
          "[@media(max-height:30rem)]:overflow-y-auto",
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

/** Title row with the Close button on desktop; the drawer header (dismissed by swipe or scrim) on phones. */
function SheetHeader({ className, children, ...props }: React.ComponentProps<"div">) {
  if (useMobile()) {
    return (
      <DrawerHeader className={className} {...props}>
        {children}
      </DrawerHeader>
    );
  }
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex min-h-12 items-start gap-2 border-b px-4 py-3", className)}
      {...props}
    >
      {children}
      <SheetPrimitive.Close asChild>
        <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Close">
          <XIcon />
        </Button>
      </SheetPrimitive.Close>
    </div>
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  if (useMobile()) return <DrawerTitle className={className} {...props} />;
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "min-w-0 flex-1 font-heading text-base leading-5 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] line-clamp-2",
        className,
      )}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  if (useMobile()) return <DrawerDescription className={className} {...props} />;
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

/** The scrolling region and a container: consumers lay out with `@sm`/`@lg`, never `@md` (the sheet is
 *  480px wide, so a container `@md` would read like the viewport breakpoint it is not). */
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        "@container min-h-0 flex-1 overflow-y-auto p-4 [@media(max-height:30rem)]:overflow-visible",
        className,
      )}
      {...props}
    />
  );
}

/** Desktop: buttons right-aligned in a row. Phones: the drawer's full-width stack, action first. */
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  if (useMobile()) return <DrawerFooter className={className} {...props} />;
  return (
    <div
      data-slot="sheet-footer"
      className={cn("flex flex-wrap justify-end gap-2 border-t p-4", className)}
      {...props}
    />
  );
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  if (useMobile()) return <DrawerClose {...props} />;
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
};
