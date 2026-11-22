import { SheetBody, SheetFooter } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { SheetKind } from "./sheet-bodies";

const ROWS: Partial<Record<SheetKind, number>> = {
  "new-agent": 5,
  "edit-agent": 5,
  "new-task": 3,
  "new-schedule": 5,
  "edit-schedule": 5,
  "new-template": 2,
  "add-credential": 3,
  "add-project": 2,
  "add-secret": 2,
};

/** Static stand-in while a body's chunk loads: field rows and a footer at the form's real heights. */
export function BodySkeleton({ kind }: { kind: SheetKind }) {
  const rows = ROWS[kind] ?? 3;
  return (
    <div
      data-slot="body-skeleton"
      role="status"
      aria-label="Loading form"
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody className="grid content-start gap-4">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static list
          <div key={i} className="grid gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </SheetBody>
      <SheetFooter>
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-28" />
      </SheetFooter>
    </div>
  );
}
