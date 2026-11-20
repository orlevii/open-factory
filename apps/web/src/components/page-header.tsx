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
}: {
  title: string;
  /** The h1's content when it needs more than the plain title (a spawned agent's kept " · ab12"). */
  heading?: ReactNode;
  documentTitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  const shell = useShell();
  useEffect(() => {
    document.title = `${documentTitle ?? title} · Open Factory`;
  }, [title, documentTitle]);
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4 md:px-6">
        <SidebarTrigger className="-ml-1.5" />
        <h1
          className={cn(
            "font-heading text-base leading-5 font-semibold tracking-[-0.01em]",
            // A custom heading may truncate (it decides which part gives way), so the h1 may shrink.
            heading !== undefined && "min-w-0 truncate",
          )}
        >
          {heading ?? title}
        </h1>
        {meta && <div className="flex min-w-0 items-center gap-2">{meta}</div>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      {shell && <ReconnectStrip lost={shell.connectionLost} />}
    </>
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
