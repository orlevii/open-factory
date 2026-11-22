import { Slot } from "radix-ui";
import * as React from "react";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { consumeLongPressRelease } from "@/hooks/use-long-press";
import { useLatchedMobile } from "@/hooks/use-latched-mobile";
import { cn } from "@/lib/utils";

type Point = { x: number; y: number };
type Ctx = {
  open: boolean;
  setOpen(open: boolean): void;
  /** Phone surface (a bottom drawer), chosen when the menu opens and kept until it opens again. */
  mobile: boolean;
  title: string;
  /** The point a long-press opened it at, latched per opening like `mobile`. */
  anchor: Point | undefined;
};
const MenuCtx = React.createContext<Ctx | null>(null);
function useMenu(name: string): Ctx {
  const ctx = React.useContext(MenuCtx);
  if (!ctx) throw new Error(`${name} must be inside AdaptiveMenu`);
  return ctx;
}

/** The app's row and header menu (spec §11.1): the U1 `DropdownMenu` at 48rem and up, a bottom drawer below.
 *  Which one is decided when it opens, like `Sheet`. `title` names the target; the drawer shows it. */
function AdaptiveMenu({
  open: openProp,
  onOpenChange,
  title,
  anchor: anchorProp,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  /** Hang a desktop dropdown from this viewport point instead of the trigger (a long-press). */
  anchor?: Point;
  children: React.ReactNode;
}) {
  const [inner, setInner] = React.useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : inner;
  // The latest onOpenChange, read by a stable setOpen so the context value doesn't churn per render.
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next);
      onOpenChangeRef.current?.(next);
    },
    [controlled],
  );
  const mobile = useLatchedMobile(open);
  // Latched on the closed → open edge (state adjusted during render), kept through the close so the
  // dropdown fades out where it was.
  const [prevOpen, setPrevOpen] = React.useState(open);
  const [anchor, setAnchor] = React.useState(open ? anchorProp : undefined);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setAnchor(anchorProp);
  }
  const ax = anchor?.x;
  const ay = anchor?.y;
  const ctx = React.useMemo<Ctx>(
    () => ({
      open,
      setOpen,
      mobile,
      title,
      anchor: ax === undefined || ay === undefined ? undefined : { x: ax, y: ay },
    }),
    [open, setOpen, mobile, title, ax, ay],
  );
  return (
    <MenuCtx.Provider value={ctx}>
      {/* One tree for both surfaces, so the trigger never remounts when the surface changes; on a phone
          the dropdown stays closed and AdaptiveMenuContent renders the drawer. */}
      <DropdownMenu open={open && !mobile} onOpenChange={setOpen}>
        {children}
      </DropdownMenu>
    </MenuCtx.Provider>
  );
}

/** Opens on `click` for touch and pen and on `pointerdown` only for a mouse, so starting a scroll on the
 *  trigger never opens a menu (spec §11.1). */
function AdaptiveMenuTrigger({
  asChild,
  onPointerDown,
  onClick,
  onKeyDown,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuTrigger>) {
  const { open, setOpen, mobile, anchor } = useMenu("AdaptiveMenuTrigger");
  // Set by a touch or pen pointerdown, read by the click it produces. Written only in handlers.
  const tapping = React.useRef(false);
  // A long-press opening on desktop: Radix anchors to its trigger, so the trigger is a stand-in at the
  // point and the visible control opens the menu itself.
  const standIn = !mobile && anchor !== undefined;
  const state = open ? "open" : "closed";
  const shared = {
    "aria-expanded": open,
    "data-state": state,
    // On a phone it opens a drawer (a dialog), and the dropdown content it would control never renders.
    ...(mobile ? { "aria-haspopup": "dialog" as const, "aria-controls": undefined } : null),
    onPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
      onPointerDown?.(e);
      if (e.defaultPrevented) return;
      if (e.pointerType !== "mouse") {
        tapping.current = true;
        // Radix's trigger skips its own open when the event is default-prevented.
        e.preventDefault();
        return;
      }
      tapping.current = false;
      // Closing is left to the dropdown's own outside-pointerdown, so onOpenChange(false) fires once.
      if (standIn && !open && e.button === 0 && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      }
    },
    onClick(e: React.MouseEvent<HTMLButtonElement>) {
      onClick?.(e);
      if (e.defaultPrevented || !tapping.current) return;
      tapping.current = false;
      setOpen(!open);
    },
  };
  if (standIn && anchor) {
    const Comp = asChild ? Slot.Root : "button";
    return (
      <>
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden="true"
            data-menu-stand-in=""
            className="pointer-events-none fixed size-0"
            style={{ left: anchor.x, top: anchor.y }}
          />
        </DropdownMenuTrigger>
        <Comp
          {...(asChild ? null : { type: "button" as const })}
          aria-haspopup="menu"
          {...props}
          {...shared}
          onKeyDown={(e: React.KeyboardEvent<HTMLButtonElement>) => {
            onKeyDown?.(e);
            if (e.defaultPrevented) return;
            if (["Enter", " ", "ArrowDown"].includes(e.key)) {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          {children}
        </Comp>
      </>
    );
  }
  return (
    <DropdownMenuTrigger asChild={asChild} {...props} {...shared} onKeyDown={onKeyDown}>
      {children}
    </DropdownMenuTrigger>
  );
}

/** Content props reach the desktop dropdown; the drawer has one fixed look and takes only the focus and
 *  dismiss handlers (a focus handoff to the overlay an item opened works on both surfaces). */
function AdaptiveMenuContent({
  children,
  onPointerUpCapture,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onInteractOutside,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  const { open, setOpen, mobile, title, anchor } = useMenu("AdaptiveMenuContent");
  if (mobile)
    return (
      <Drawer open={open} onOpenChange={setOpen} direction="bottom">
        <DrawerContent
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          onEscapeKeyDown={onEscapeKeyDown}
          onInteractOutside={onInteractOutside}
          onPointerDownOutside={onPointerDownOutside}
        >
          <DrawerTitle className="px-4 pt-1 pb-2 font-sans text-sm font-normal tracking-normal text-muted-foreground line-clamp-1">
            {title}
          </DrawerTitle>
          <div data-slot="adaptive-menu-items" className="flex min-h-0 flex-col overflow-y-auto">
            {children}
          </div>
          {/* A rule and 8px between the items (a destructive last item among them) and Cancel. */}
          <div aria-hidden="true" data-slot="adaptive-menu-cancel-rule" className="mt-2 h-px shrink-0 bg-border" />
          <button
            type="button"
            data-slot="adaptive-menu-item"
            className={ITEM}
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </DrawerContent>
      </Drawer>
    );
  return (
    <DropdownMenuContent
      {...(anchor
        ? // The stand-in it hangs from is empty and hidden: name the menu by its target instead.
          { align: "start" as const, side: "bottom" as const, "aria-label": title, "aria-labelledby": undefined }
        : null)}
      {...props}
      onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={onEscapeKeyDown}
      onInteractOutside={onInteractOutside}
      onPointerDownOutside={onPointerDownOutside}
      onPointerUpCapture={(e) => {
        onPointerUpCapture?.(e);
        // The finger that long-pressed the row lifts over the menu: that release selects nothing.
        if (consumeLongPressRelease()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {children}
    </DropdownMenuContent>
  );
}

const ITEM =
  "flex min-h-11 w-full shrink-0 cursor-default items-center gap-2 px-4 py-2 text-left text-base outline-hidden select-none [overflow-wrap:anywhere] active:bg-accent focus-visible:bg-accent data-[variant=destructive]:text-destructive data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"; // ui-contract:allow focus is a fill

/** Stamps the open surface (and a drawer's own overlay) so its close is instant: the overlay the item opens
 *  rises alone, and two drawers never cross on the same edge. */
function stampSurface(from: Element) {
  const drawer = from.closest("[data-slot=drawer-content]");
  if (drawer) {
    drawer.setAttribute("data-instant", "");
    // Vaul portals the overlay and the content side by side, overlay first.
    const overlay = drawer.previousElementSibling;
    if (overlay?.getAttribute("data-slot") === "drawer-overlay") overlay.setAttribute("data-instant", "");
    return;
  }
  from.closest("[data-slot=dropdown-menu-content]")?.setAttribute("data-instant", "");
}

function AdaptiveMenuItem({
  asChild,
  variant,
  opensOverlay,
  onSelect,
  disabled,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuItem>, "variant"> & {
  variant?: "destructive";
  /** It opens a sheet, dialog or popover: the menu closes instantly so only the new overlay animates. */
  opensOverlay?: boolean;
}) {
  const { setOpen, mobile } = useMenu("AdaptiveMenuItem");
  if (!mobile)
    return (
      <DropdownMenuItem
        asChild={asChild}
        variant={variant}
        disabled={disabled}
        className={className}
        {...props}
        onSelect={(e) => {
          onSelect?.(e);
          if (!e.defaultPrevented && opensOverlay && e.currentTarget instanceof Element) stampSurface(e.currentTarget);
        }}
      >
        {children}
      </DropdownMenuItem>
    );
  const Comp = asChild ? Slot.Root : "button";
  const { onClick, ...rest } = props as React.ComponentProps<"button">;
  return (
      <Comp
        {...(asChild ? null : { type: "button" as const })}
        {...rest}
        data-slot="adaptive-menu-item"
        data-variant={variant}
        data-disabled={disabled ? "" : undefined}
        aria-disabled={disabled || undefined}
        className={cn(ITEM, className)}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          onClick?.(e);
          if (disabled || e.defaultPrevented) return;
          const target = e.currentTarget;
          const select = new Event("menu.itemSelect", { bubbles: false, cancelable: true });
          onSelect?.(select);
          if (select.defaultPrevented) return;
          if (opensOverlay) stampSurface(target);
          setOpen(false);
        }}
      >
        {children}
      </Comp>
  );
}

function AdaptiveMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuSeparator>) {
  const { mobile } = useMenu("AdaptiveMenuSeparator");
  if (!mobile) return <DropdownMenuSeparator className={className} {...props} />;
  return (
    <div
      role="separator"
      data-slot="adaptive-menu-separator"
      className={cn("my-1 h-px shrink-0 bg-border", className)}
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

function AdaptiveMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuLabel>) {
  const { mobile } = useMenu("AdaptiveMenuLabel");
  if (!mobile) return <DropdownMenuLabel className={className} {...props} />;
  return (
    <div
      data-slot="adaptive-menu-label"
      className={cn("px-4 pt-2 pb-1 text-xs font-medium text-muted-foreground", className)}
      {...(props as React.ComponentProps<"div">)}
    />
  );
}

/** Keyboard shortcuts mean nothing on a phone: hidden there. */
function AdaptiveMenuShortcut(props: React.ComponentProps<typeof DropdownMenuShortcut>) {
  const { mobile } = useMenu("AdaptiveMenuShortcut");
  return mobile ? null : <DropdownMenuShortcut {...props} />;
}

export {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuLabel,
  AdaptiveMenuSeparator,
  AdaptiveMenuShortcut,
  AdaptiveMenuTrigger,
};
