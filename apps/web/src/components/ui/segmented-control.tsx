import type { ReactNode } from "react";
import { cn } from "cn";

/** 2–4 short fixed choices as native radios (arrow keys and form semantics for free). Options from data,
 *  or more than four, belong in a Select (DESIGN.md → Form controls). */
export function SegmentedControl<V extends string | number>(p: {
  legend: string; legendVisible?: boolean; name: string; value: V;
  options: readonly {
    value: V; label: ReactNode;
    /** Unavailable but still focusable and selectable by keyboard: `aria-disabled`, and picking it does nothing.
     *  `describedBy` names the note that says why. */
    unavailable?: boolean; describedBy?: string;
  }[];
  onChange(value: V): void;
  size?: "sm" | "default"; block?: boolean; className?: string;
  /** Ids of the notes that describe the whole group. */
  describedBy?: string;
}) {
  return (
    <fieldset aria-describedby={p.describedBy} className={cn("min-w-0 max-w-full", p.block && "w-full", p.className)}>
      <legend className={p.legendVisible ? "mb-1.5 text-[0.8125rem] font-medium" : "sr-only"}>{p.legend}</legend>
      <div
        data-slot="segmented-track"
        className={cn(
          "inline-flex max-w-full rounded-lg bg-muted p-0.5 dark:bg-background pointer-coarse:h-9",
          p.size === "sm" ? "h-7" : "h-8",
          p.block && "flex w-full",
        )}
      >
        {p.options.map((o) => (
          <label
            key={String(o.value)}
            className={cn(
              "flex h-full min-w-0 cursor-pointer items-center justify-center rounded-md border border-transparent px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-[background-color,color,border-color] duration-150 ease-(--ease-out) hover:text-foreground",
              "has-checked:border-border has-checked:bg-card has-checked:text-foreground dark:has-checked:bg-accent",
              "has-aria-disabled:cursor-not-allowed has-aria-disabled:text-muted-foreground has-aria-disabled:hover:text-muted-foreground",
              "has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
              p.block && "flex-1",
            )}
          >
            <input type="radio" name={p.name} value={String(o.value)} checked={p.value === o.value}
              aria-disabled={o.unavailable || undefined} aria-describedby={o.describedBy}
              onChange={() => !o.unavailable && p.onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
