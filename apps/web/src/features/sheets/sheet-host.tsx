import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  Component,
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  closeSheetInstantly,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { lastInputModality } from "@/lib/input-modality";
import { BodySkeleton } from "./body-skeleton";
import { HeaderSlotContext } from "./header-slot";
import {
  type BodyProps,
  bindSheetQueryClient,
  childDescription,
  loadBody,
  preloadSheet,
  resetBodyLoad,
  type SheetKind,
  sheetBodies,
  sheetTitle,
  sheetTitleClass,
} from "./sheet-bodies";
import {
  type ChildSpec,
  closeChildSheet,
  closeSheet,
  getSheetState,
  type OpenChild,
  type OpenParent,
  setPathnameSource,
  takeChildReturnFocus,
  useSheet,
} from "./sheet-store";

// Created once per entry (module scope), on first use; they share the import with `preloadSheet`.
const lazies = new WeakMap<object, ComponentType<BodyProps<any>>>();
function bodyFor(kind: SheetKind) {
  const entry = sheetBodies[kind];
  if (!entry) return undefined;
  let c = lazies.get(entry);
  if (!c) {
    c = lazy(() => loadBody(entry));
    lazies.set(entry, c);
  }
  return c;
}

/** A chunk that fails to load (offline, a stale deploy) shows a retry inside the sheet; the page and shell stay up. */
class BodyBoundary extends Component<
  { children: ReactNode; onRetry(): void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  retry = () => {
    this.props.onRetry();
    this.setState({ failed: false });
  };
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="grid flex-1 content-start justify-items-start gap-3 p-4 text-sm">
        <p>This form didn't load.</p>
        <Button type="button" variant="ghost" onClick={this.retry}>
          Retry
        </Button>
      </div>
    );
  }
}

function BodyView({ spec, close }: { spec: OpenParent | OpenChild; close(): void }) {
  const Body = bodyFor(spec.kind);
  return Body ? <Body spec={spec} sheetId={spec.id} close={close} /> : null;
}

const stampBoth = () => {
  for (const el of document.querySelectorAll(
    "[data-slot=sheet-content], [data-slot=sheet-overlay], [data-slot=drawer-content], [data-slot=drawer-overlay]",
  ))
    el.setAttribute("data-instant", "");
};

function SheetLayer({
  spec,
  open,
  onClose,
  stacked,
  parentTitle,
  returnFocus,
}: {
  spec: (OpenParent | OpenChild) | undefined;
  open: boolean;
  onClose(): void;
  stacked?: boolean;
  /** A stacked child names the parent it serves in its description. */
  parentTitle?: string;
  /** Where focus goes on close; null keeps Radix's return to the trigger. */
  returnFocus?: () => HTMLElement | null;
}) {
  // Kept after close so the exit animation still has its content.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  /** What had focus when the sheet opened (a row's menu button, a header button): Close returns there. */
  const opener = useRef<HTMLElement | null>(null);
  const last = useRef(spec);
  if (spec) last.current = spec;
  const shown = last.current;
  if (!shown) return null;
  const title = sheetTitle(shown.kind, shown);
  const description = parentTitle ? childDescription(shown.kind, parentTitle) : undefined;
  // A body's own close (after a submit): from the keyboard it is instant, on this layer only (§5.3).
  const close = () => {
    if (lastInputModality() === "keyboard") closeSheetInstantly(content.current);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      stacked={stacked}
      onStripClick={onClose}
    >
      <SheetContent
        ref={content}
        // Focus-on-open is the body's job, on mount (`useFocusOnOpen`). Until then the panel itself holds focus,
        // inside the trap; on phones that is the drawer content's own rule.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const el = e.currentTarget as HTMLElement;
          const at = document.activeElement;
          // Each open has its own opener: one that starts with focus on the page body has none (the layer stays
          // mounted across opens, so the last open's opener would otherwise linger).
          opener.current = null;
          if (at instanceof HTMLElement && at !== document.body && !el.contains(at))
            opener.current = at;
          if (!el.contains(at)) el.focus({ preventScroll: true });
        }}
        returnFocus={() => returnFocus?.() ?? (opener.current?.isConnected ? opener.current : null)}
        data-instant={"instant" in shown && shown.instant ? "" : undefined}
      >
        <SheetHeader>
          <SheetTitle className={sheetTitleClass(shown.kind)}>{title}</SheetTitle>
          <span ref={setSlot} className="contents" />
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <BodyBoundary
          key={shown.kind}
          onRetry={() => {
            const entry = sheetBodies[shown.kind];
            if (!entry) return;
            lazies.delete(entry);
            resetBodyLoad(entry);
          }}
        >
          <Suspense fallback={<BodySkeleton kind={shown.kind} />}>
            <HeaderSlotContext value={slot}>
              <BodyView key={shown.id} spec={shown} close={close} />
            </HeaderSlotContext>
          </Suspense>
        </BodyBoundary>
      </SheetContent>
    </Sheet>
  );
}

/** One host in the app layout: the parent sheet and, over it, the child. */
export function SheetHost() {
  const { parent, child } = useSheet();
  const router = useRouter();
  const qc = useQueryClient();

  useEffect(() => {
    setPathnameSource(() => router.state.resolvedLocation?.pathname ?? window.location.pathname);
    bindSheetQueryClient(qc);
    const unsubscribe = router.subscribe("onResolved", (e) => {
      const p = getSheetState().parent;
      if (p && e.toLocation.pathname !== p.at) {
        stampBoth();
        closeSheet();
      }
    });
    return () => {
      unsubscribe();
      bindSheetQueryClient(undefined);
    };
  }, [router, qc]);

  // Every open starts the chunk and the body's queries together.
  const parentId = parent?.id;
  const childId = child?.id;
  useEffect(() => {
    if (parentId !== undefined)
      preloadSheet(getSheetState().parent?.kind as SheetKind, getSheetState().parent);
  }, [parentId]);
  useEffect(() => {
    if (childId !== undefined)
      preloadSheet(getSheetState().child?.kind as SheetKind, getSheetState().child as ChildSpec);
  }, [childId]);

  const parentTitle = parent ? sheetTitle(parent.kind, parent) : undefined;
  return (
    <>
      <SheetLayer spec={parent} open={!!parent} onClose={closeSheet} />
      <SheetLayer
        spec={child}
        open={!!child}
        onClose={closeChildSheet}
        stacked
        parentTitle={parentTitle}
        // A child that served its parent hands focus to the field it filled (§7).
        returnFocus={takeChildReturnFocus}
      />
    </>
  );
}
