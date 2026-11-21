import { type ReactNode, useEffect } from "react";
import { useShell } from "@/components/shell-context";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/** The one header every signed-in screen renders: sidebar trigger, the page h1, an actions slot. */
export function PageHeader({
  title,
  heading,
  documentTitle,
  meta,
  actions,
  titleFromData = false,
}: {
  title: string;
  /** The h1's content when it needs more than the plain title (a spawned agent's kept " · ab12"). */
  heading?: ReactNode;
  documentTitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  /** The title is data (an agent or task name): it truncates down to a 4rem floor. A static title never shrinks. */
  titleFromData?: boolean;
}) {
  const shell = useShell();
  useEffect(() => {
    document.title = `${documentTitle ?? title} · Open Factory`;
  }, [title, documentTitle]);
  return (
    <>
      <header className="@container flex h-12 shrink-0 items-center gap-2 border-b px-4 md:px-6">
        <SidebarTrigger className="-ml-1.5" />
        <h1
          className={cn(
            "font-heading text-base leading-5 font-semibold tracking-[-0.01em]",
            // Give-way order: the meta slug (it never takes room from the title), then a data title (to a
            // floor), then nothing else shrinks.
            // Below a 22rem header the floor drops to 2rem: at 320px a long name, the Hibernated badge and
            // three icon actions don't fit beside a 4rem floor, and the actions would leave the screen.
            titleFromData
              ? "min-w-16 truncate @max-[22rem]:min-w-8"
              : heading !== undefined
                ? "min-w-0 truncate"
                : "shrink-0",
          )}
          title={titleFromData ? title : undefined}
        >
          {heading ?? title}
        </h1>
        {/* No box of its own: the badge and slug are the header's items, so a truncating title can't
            squeeze a wrapper to 0px under a shrink-0 badge (the actions would paint over it). */}
        {meta && <div className="contents">{meta}</div>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {shell && <ReconnectStrip lost={shell.connectionLost} />}
    </>
  );
}

/**
 * A mono name inside `meta`: the first thing to give way, strictly. A zero basis that grows up to its own width
 * means it only takes the room the title and badge leave, so it truncates to nothing before the title shrinks.
 * It hides on a narrow header.
 */
export function HeaderSlug({ value }: { value: string }) {
  return (
    <span
      data-slot="header-slug"
      title={value}
      className="min-w-0 max-w-max grow basis-0 truncate font-mono text-muted-foreground @max-[32rem]:hidden"
    >
      {value}
    </span>
  );
}

/** The live region is always mounted (empty when connected) so screen readers announce the change. */
function ReconnectStrip({ lost }: { lost: boolean }) {
  return (
    <div role="status" aria-live="polite" className="shrink-0">
      {lost && (
        <div className="flex h-8 items-center gap-2 bg-muted px-4 text-[0.8125rem] text-muted-foreground md:px-6">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          Connection lost. Reconnecting…
        </div>
      )}
    </div>
  );
}

/** Screen body below the PageHeader. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 md:px-6">{children}</div>;
}
