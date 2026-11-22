import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { type ComponentType, lazy, Suspense, useEffect, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { BodySkeleton } from "./body-skeleton";
import {
  type BodyProps,
  bindSheetQueryClient,
  loadBody,
  preloadSheet,
  type SheetKind,
  sheetBodies,
} from "./sheet-bodies";
import {
  type ChildSpec,
  closeChildSheet,
  closeSheet,
  getSheetState,
  type OpenChild,
  type OpenParent,
  setPathnameSource,
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
  description,
}: {
  spec: (OpenParent | OpenChild) | undefined;
  open: boolean;
  onClose(): void;
  stacked?: boolean;
  description?: string;
}) {
  // Kept after close so the exit animation still has its content.
  const last = useRef(spec);
  if (spec) last.current = spec;
  const shown = last.current;
  if (!shown) return null;
  const Body = bodyFor(shown.kind);
  const title = sheetBodies[shown.kind]?.title ?? "";
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      stacked={stacked}
      onStripClick={onClose}
    >
      <SheetContent
        // Focus-on-open is the body's job, on mount.
        onOpenAutoFocus={(e) => e.preventDefault()}
        data-instant={"instant" in shown && shown.instant ? "" : undefined}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <Suspense fallback={<BodySkeleton kind={shown.kind} />}>
          {Body && <Body spec={shown} sheetId={shown.id} close={onClose} />}
        </Suspense>
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

  const parentTitle = parent ? sheetBodies[parent.kind]?.title : undefined;
  return (
    <>
      <SheetLayer spec={parent} open={!!parent} onClose={closeSheet} />
      <SheetLayer
        spec={child}
        open={!!child}
        onClose={closeChildSheet}
        stacked
        description={parentTitle ? `For ${parentTitle}` : undefined}
      />
    </>
  );
}
