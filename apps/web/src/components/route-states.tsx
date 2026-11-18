import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useShell } from "@/components/shell-context";
import { Button } from "@/components/ui/button";
import { Mark, Wordmark } from "@/components/wordmark";

/** Router pending screen (UI design §5.1): only the mark, its pilot light breathing. Shown only
 *  after defaultPendingMs, so fast loads never flash it. */
export function AppPending() {
  const status = (
    <div
      role="status"
      aria-live="polite"
      className="is-loading fixed inset-0 flex items-center justify-center bg-background text-foreground"
    >
      <Mark className="size-7" />
      <span className="sr-only">Loading…</span>
    </div>
  );
  // At the root (first load) there is no shell, so the page still needs its one <main>.
  return useShell() ? status : <main>{status}</main>;
}

function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Open Factory`;
  }, [title]);
}

/** Inside the signed-in shell the state renders in the content area (the shell owns <main>);
 *  outside it (auth pages, a failed session check) it brings its own <main> and the wordmark. */
function StateFrame({ children }: { children: ReactNode }) {
  const body = <div className="grid max-w-xl gap-3 px-4 py-6 md:px-6">{children}</div>;
  if (useShell()) return body;
  return (
    <main className="min-h-svh py-6">
      <div className="px-4 md:px-6">
        <Wordmark />
      </div>
      {body}
    </main>
  );
}

export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  usePageTitle("Something went wrong");
  const message = error instanceof Error ? error.message : String(error);
  return (
    <StateFrame>
      <h2 className="text-[15px] leading-5 font-semibold">Something went wrong.</h2>
      <p className="text-[13px] leading-[18px] text-muted-foreground">
        This page hit an error it couldn't recover from.
      </p>
      {message && (
        <pre className="max-h-40 overflow-auto rounded-md border border-code-border bg-code p-3 text-xs whitespace-pre-wrap">
          {message}
        </pre>
      )}
      <div className="flex items-center gap-2">
        {/* invalidate() reloads the route's data and resets the error boundary in one step. */}
        <Button className="h-9" onClick={() => void router.invalidate()}>
          Retry
        </Button>
        <Button className="h-9" variant="ghost" asChild>
          <Link to="/">Go to Home</Link>
        </Button>
      </div>
    </StateFrame>
  );
}

export function NotFound() {
  usePageTitle("Page not found");
  return (
    <StateFrame>
      <h2 className="text-[15px] leading-5 font-semibold">Page not found.</h2>
      <p className="text-[13px] leading-[18px] text-muted-foreground">
        Check the address, or go back to Home.
      </p>
      <div className="flex items-center gap-2">
        <Button className="h-9" asChild>
          <Link to="/">Go to Home</Link>
        </Button>
      </div>
    </StateFrame>
  );
}
