import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import * as React from "react";
import { Button, COARSE_ICON_GROUP } from "@/components/ui/button";
import {
  Drawer,
  DrawerBody,
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

const SheetCtx = React.createContext<{ mobile: boolean; modal: boolean; stacked: boolean; onStripClick?: () => void }>({
  mobile: false,
  modal: true,
  stacked: false,
});
const useMobile = () => React.useContext(SheetCtx).mobile;
/** Whether the enclosing sheet renders as a phone drawer (latched per opening). */
const useSheetMobile = useMobile;

/** One sheet for create/edit forms and peeks (DESIGN.md → Overlays): a 480px right panel on desktop, a
 *  bottom drawer below md. The choice is made per opening (spec §5.1). Dismissing never asks. */
function Sheet({
  open,
  onOpenChange,
  modal = true,
  stacked = false,
  onStripClick,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** `false` makes a desktop peek: no scrim, no focus trap, the page behind stays usable. Phones are always modal. */
  modal?: boolean;
  /** A child over another sheet: 48px narrower on desktop so a strip of the parent shows, 82svh on phones. */
  stacked?: boolean;
  /** Desktop: the dimmed strip (this sheet's overlay) was clicked. It still closes only this sheet.
   *  Pass a stable callback (useCallback): it sits in the context value every SheetContent reads. */
  onStripClick?: () => void;
  children: React.ReactNode;
}) {
  const mobile = useLatchedMobile(open);
  const ctx = React.useMemo(
    () => ({ mobile, modal: modal || mobile, stacked, onStripClick }),
    [mobile, modal, stacked, onStripClick],
  );
  return (
    <SheetCtx.Provider value={ctx}>
      {mobile ? (
        <Drawer open={open} onOpenChange={onOpenChange} direction="bottom" stacked={stacked}>
          {children}
        </Drawer>
      ) : (
        <SheetPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
          {children}
        </SheetPrimitive.Root>
      )}
    </SheetCtx.Provider>
  );
}

/** Each desktop SheetContent registers its own overlay here, so a stacked child never stamps its parent's
 *  (every sheet's overlay and content sit under <body>; the DOM can't pair them). */
const overlayOf = new WeakMap<HTMLElement, HTMLElement>();

/** A key that closes an overlay stamps `data-instant` on the content and its own overlay first, so the
 *  close is instant however it opened. */
function closeSheetInstantly(contentEl: HTMLElement | null | undefined, onOpenChange?: (open: boolean) => void) {
  stampPair(contentEl);
  onOpenChange?.(false);
}

function stampPair(contentEl: HTMLElement | null | undefined) {
  if (!contentEl) return;
  contentEl.setAttribute("data-instant", "");
  // A drawer's overlay is its content's sibling in the same Vaul portal.
  const prev = contentEl.previousElementSibling;
  const overlay =
    overlayOf.get(contentEl) ?? (prev?.matches("[data-slot=drawer-overlay]") ? prev : undefined);
  overlay?.setAttribute("data-instant", "");
}

const WIDTH = { sheet: "w-[min(30rem,100%)]", panel: "w-[min(20rem,100%)]" } as const;
const STACKED_WIDTH = "w-[min(27rem,100%)]";
const INSET = { full: "inset-y-0", "below-header": "top-12 bottom-0" } as const;

/** Travels 100% of its width with no panel fade; under reduced motion it fades instead (the global
 *  reduced-motion rule zeroes the slide). No shadow: the scrim and the edge rule separate it. */
function SheetContent({
  className,
  children,
  ref,
  width = "sheet",
  inset = "full",
  returnFocus,
  keepFocus,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onInteractOutside,
  onFocusOutside,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  width?: keyof typeof WIDTH;
  inset?: keyof typeof INSET;
  /** Where focus goes on close, sheet or drawer (a close without a trigger leaves it on <body>). */
  returnFocus?: () => HTMLElement | null;
  /** Opening leaves focus where it was (a peek opened by a key on a list). */
  keepFocus?: boolean;
}) {
  const { mobile, modal, stacked, onStripClick } = React.useContext(SheetCtx);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const composed = React.useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (typeof ref === "function") return ref(node);
      if (ref) (ref as React.RefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );
  const overlayRef = React.useRef<HTMLElement | null>(null);
  const registerOverlay = React.useCallback((node: HTMLDivElement | null) => {
    overlayRef.current = node;
    stampInstant(node);
  }, []);
  const registeredRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      composed(node);
      if (node && overlayRef.current) overlayOf.set(node, overlayRef.current);
    },
    [composed],
  );
  const stampedRef = useStampedRef(registeredRef);
  const closeAutoFocus = (e: Event) => {
    onCloseAutoFocus?.(e);
    if (e.defaultPrevented) return;
    const target = returnFocus?.();
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };
  if (mobile) {
    return (
      <DrawerContent
        ref={ref}
        className={className}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={closeAutoFocus}
        onEscapeKeyDown={onEscapeKeyDown}
        onInteractOutside={onInteractOutside}
        onFocusOutside={onFocusOutside}
        {...props}
      >
        {children}
      </DrawerContent>
    );
  }
  return (
    <SheetPrimitive.Portal>
      {modal && (
        <SheetPrimitive.Overlay
          data-slot="sheet-overlay"
          ref={registerOverlay}
          onClick={stacked ? onStripClick : undefined}
          className="fixed inset-0 z-50 bg-black/20 duration-250 ease-(--ease-drawer) data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-200 data-closed:ease-(--ease-out) dark:bg-black/40"
        />
      )}
      <SheetPrimitive.Content
        data-slot="sheet-content"
        // The shortcut layer keeps working beside a non-modal peek.
        data-modal={modal ? undefined : "false"}
        ref={stampedRef}
        className={cn(
          "fixed right-0 z-50 flex flex-col border-l border-float-edge bg-popover text-sm text-popover-foreground outline-none", // ui-contract:allow the panel holds focus only until its body focuses a field; the ring belongs on controls
          "duration-250 ease-(--ease-drawer) data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right data-closed:duration-200 data-closed:ease-(--ease-out)",
          "motion-reduce:data-open:fade-in-0 motion-reduce:data-closed:fade-out-0",
          "[@media(max-height:30rem)]:overflow-y-auto",
          INSET[inset],
          stacked ? STACKED_WIDTH : WIDTH[width],
          className,
        )}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (keepFocus) e.preventDefault();
        }}
        onCloseAutoFocus={closeAutoFocus}
        onEscapeKeyDown={(e) => {
          onEscapeKeyDown?.(e);
          if (!e.defaultPrevented) stampPair(contentRef.current);
        }}
        onInteractOutside={(e) => {
          onInteractOutside?.(e);
          if (!modal) e.preventDefault();
        }}
        onFocusOutside={(e) => {
          onFocusOutside?.(e);
          if (!modal) e.preventDefault();
        }}
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
      // On coarse pointers its icon buttons (Close, a body's header action) are 40px boxes 4px apart; the negative
      // margin keeps the row's height.
      className={cn(
        "flex min-h-12 items-start gap-2 border-b px-4 py-3",
        COARSE_ICON_GROUP,
        "pointer-coarse:[&_[data-size^=icon]]:-my-1.5",
        className
      )}
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
      className={cn("text-sm text-muted-foreground [overflow-wrap:anywhere]", className)}
      {...props}
    />
  );
}

/** The scrolling region and a container: consumers lay out with `@sm`/`@lg`, never `@md` (the sheet is
 *  480px wide, so a container `@md` would read like the viewport breakpoint it is not). On a short desktop
 *  viewport the whole panel scrolls instead; the drawer body always scrolls itself. */
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  if (useMobile()) return <DrawerBody className={className} {...props} />;
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
  closeSheetInstantly,
  closeSheetInstantly as closeInstantly,
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  useSheetMobile,
};
