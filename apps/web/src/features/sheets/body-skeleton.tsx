import { SheetBody, SheetFooter } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { SheetKind } from "./sheet-bodies";

/** A field (label + control) or a one-line row (New agent's address line and More options). */
type Row = "field" | "line";
const LAYOUT: Partial<Record<SheetKind, Row[]>> = {
  "new-agent": ["field", "field", "line", "field", "line"],
};
const ROWS: Partial<Record<SheetKind, number>> = {
  "edit-agent": 5,
  "new-task": 3,
  "new-schedule": 5,
  "edit-schedule": 5,
  "new-template": 2,
  "add-credential": 3,
  "add-project": 2,
  "add-skills": 3,
  "add-marketplace": 3,
  "add-secret": 2,
  "sign-in-again": 2,
};

/** Static stand-in while a body's chunk loads: field rows and a footer at the form's real heights. */
export function BodySkeleton({ kind }: { kind: SheetKind }) {
  const rows: Row[] = LAYOUT[kind] ?? Array.from({ length: ROWS[kind] ?? 3 }, () => "field");
  return (
    <div
      data-slot="body-skeleton"
      role="status"
      aria-label="Loading form"
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody className="grid content-start gap-4">
        {rows.map((row, i) =>
          row === "line" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static list
            <Skeleton key={i} className="h-7 w-40" />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static list
            <div key={i} className="grid gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
          ),
        )}
      </SheetBody>
      <SheetFooter>
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-28" />
      </SheetFooter>
    </div>
  );
}
