import * as React from "react";
import { Drawer as Vaul } from "vaul";
import { collapseEmbeddedOnEscape } from "@/components/forms/embedded";
import { stampInstant, useStampedRef } from "@/lib/input-modality";
import { cn } from "@/lib/utils";

type Direction = "bottom" | "left";
const Ctx = React.createContext<{ direction: Direction; released: boolean; stacked: boolean }>({ direction: "bottom", released: false, stacked: false });

/** Vaul drawer (DESIGN.md → Overlays, Gesture UI). Focus moves in on open (Vaul's default would leave it
 *  behind the scrim); a drag that ends in a close leaves on the drawer curve (data-released). */
function Drawer({ direction = "bottom", autoFocus = true, stacked = false, onRelease, onOpenChange, open, ...props }:
  React.ComponentProps<typeof Vaul.Root> & { direction?: Direction;
    /** A child drawer over another: its own Root (not NestedRoot, which scales the parent) with `noBodyStyles`,
     *  because Vaul keeps one module-level saved body position that a second Root would clobber. */
    stacked?: boolean }) {
  const [released, setReleased] = React.useState(false);
  // Controlled: a fresh opening clears the mark during render. Uncontrolled: onOpenChange(true) does.
  const [prevOpen, setPrevOpen] = React.useState(open);
  if (open !== prevOpen) { setPrevOpen(open); if (open) setReleased(false); }
  const ctx = React.useMemo(() => ({ direction, released, stacked }), [direction, released, stacked]);
  return (
    <Ctx.Provider value={ctx}>
      <Vaul.Root data-slot="drawer" direction={direction} autoFocus={autoFocus} open={open} noBodyStyles={stacked || undefined}
        onOpenChange={(next) => { if (next) setReleased(false); onOpenChange?.(next); }}
        onRelease={(e, stillOpen) => { if (!stillOpen) setReleased(true); onRelease?.(e, stillOpen); }}
        {...props} />
    </Ctx.Provider>
  );
}

function DrawerContent({ className, children, onOpenAutoFocus, onEscapeKeyDown, ref, ...props }: React.ComponentProps<typeof Vaul.Content>) {
  const { direction, released, stacked } = React.useContext(Ctx);
  const stampedRef = useStampedRef(ref);
  return (
    <Vaul.Portal>
      <Vaul.Overlay data-slot="drawer-overlay" ref={stampInstant}
        className="fixed inset-0 z-50 bg-black/20 dark:bg-black/40" />
      <Vaul.Content
        data-slot="drawer-content"
        ref={stampedRef}
        data-released={released ? "" : undefined}
        tabIndex={-1}
        onEscapeKeyDown={(e) => {
          collapseEmbeddedOnEscape(e);
          onEscapeKeyDown?.(e);
        }}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (e.defaultPrevented) return;
          // The content, not the first input: the iOS keyboard must not rise mid-slide.
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
        className={cn(
          "group fixed z-50 flex flex-col bg-popover text-sm text-popover-foreground outline-none", // ui-contract:allow the drawer surface takes focus programmatically on open
          direction === "bottom"
            ? cn(
                "inset-x-0 bottom-0 rounded-t-xl border-t border-float-edge pb-[max(1rem,env(safe-area-inset-bottom))]",
                stacked ? "max-h-[82svh]" : "max-h-[90svh]",
              )
            : // The portal sits in <body>, outside sidebar-wrapper: fall back to SIDEBAR_WIDTH (16rem).
              "inset-y-0 left-0 w-[var(--sidebar-width,16rem)] max-w-[85vw] border-r border-float-edge",
          className,
        )}
        {...props}
      >
        <div data-slot="drawer-inner"
          className={cn("flex min-h-0 flex-1 flex-col motion-reduce:animate-in motion-reduce:fade-in-0 group-data-[state=closed]:motion-reduce:animate-out group-data-[state=closed]:motion-reduce:fade-out-0",
            direction === "bottom" && "mx-auto w-full max-w-lg")}>
          {direction === "bottom" && <div aria-hidden="true" className="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-full bg-border" />}
          {children}
        </div>
      </Vaul.Content>
    </Vaul.Portal>
  );
}

const DrawerHeader = ({ className, ...p }: React.ComponentProps<"div">) => (
  <div data-slot="drawer-header" className={cn("flex min-h-12 items-start gap-2 border-b px-4 py-3", className)} {...p} />
);
const DrawerTitle = ({ className, ...p }: React.ComponentProps<typeof Vaul.Title>) => (
  <Vaul.Title data-slot="drawer-title" className={cn("min-w-0 flex-1 font-heading text-base leading-5 font-semibold tracking-[-0.01em] [overflow-wrap:anywhere] line-clamp-2", className)} {...p} />
);
const DrawerDescription = ({ className, ...p }: React.ComponentProps<typeof Vaul.Description>) => (
  <Vaul.Description data-slot="drawer-description" className={cn("text-sm text-muted-foreground [overflow-wrap:anywhere]", className)} {...p} />
);
const DrawerBody = ({ className, ...p }: React.ComponentProps<"div">) => (
  <div data-slot="drawer-body" className={cn("@container min-h-0 flex-1 overflow-y-auto p-4", className)} {...p} />
);
/** Full-width stacked buttons: the action first, Cancel last at the bottom (DESIGN.md → Overlays). */
const DrawerFooter = ({ className, ...p }: React.ComponentProps<"div">) => (
  <div data-slot="drawer-footer" className={cn("flex flex-col gap-2 border-t px-4 pt-4 [&>*]:w-full", className)} {...p} />
);
const DrawerClose = Vaul.Close;

export { Drawer, DrawerBody, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle };
