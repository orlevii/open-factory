import { cn } from "@/lib/utils";

/** The brand mark: an ink tile with three stacked agents and the vermilion pilot light. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className={cn("shrink-0", className)}>
      <rect width="18" height="18" rx="5" fill="currentColor" />
      <rect x="4" y="4.5" width="6" height="2" rx="1" fill="var(--background)" />
      <rect x="4" y="8" width="6" height="2" rx="1" fill="var(--background)" />
      <rect x="4" y="11.5" width="6" height="2" rx="1" fill="var(--background)" />
      <circle cx="13" cy="9" r="2" fill="var(--signal)" className="pilot" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-foreground", className)}>
      <Mark className="size-[18px]" />
      <span className="text-[14px] font-semibold tracking-tight">Open Factory</span>
    </span>
  );
}
