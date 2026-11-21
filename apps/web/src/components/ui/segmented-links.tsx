import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import type { ReactNode } from "react";

/** The SegmentedControl look on links: views that are routes, not a form value. Plain links in a
 *  labelled nav (Tab between them, no radio semantics); the router marks the current one with
 *  `aria-current="page"` (exact match, so a parent path isn't current on its child). */
export function SegmentedLinks(p: {
  label: string;
  items: readonly { to: string; label: ReactNode }[];
  className?: string;
}) {
  return (
    <nav aria-label={p.label} className={cn("min-w-0 max-w-full", p.className)}>
      <div
        data-slot="segmented-track"
        className="inline-flex h-8 max-w-full rounded-lg bg-muted p-0.5 dark:bg-background pointer-coarse:h-9"
      >
        {p.items.map((i) => (
          <Link
            key={i.to}
            to={i.to}
            activeOptions={{ exact: true, includeHash: false, includeSearch: false }}
            className={cn(
              "flex h-full min-w-0 items-center justify-center rounded-md border border-transparent px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-[background-color,color,border-color] duration-150 ease-(--ease-out) hover:text-foreground",
              "aria-[current=page]:border-border aria-[current=page]:bg-card aria-[current=page]:text-foreground dark:aria-[current=page]:bg-accent",
            )}
          >
            {i.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
