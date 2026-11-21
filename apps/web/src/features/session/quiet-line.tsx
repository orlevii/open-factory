import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

const LINE =
  "flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

/** A 13px muted line with an optional icon; with `detail` it expands to show it in a code plate. */
export function QuietLine({
  icon,
  children,
  detail,
  rowProps,
}: {
  icon?: ReactNode;
  children: ReactNode;
  detail?: string;
  rowProps?: Record<string, unknown>;
}) {
  const content = (
    <>
      {icon}
      <span className="min-w-0">{children}</span>
    </>
  );
  if (!detail)
    return (
      <p {...rowProps} className={LINE}>
        {content}
      </p>
    );
  return (
    <details className="group">
      <summary {...rowProps} className={`${LINE} cursor-pointer list-none`}>
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform duration-150 ease-(--ease-out) group-open:rotate-90 motion-reduce:transition-none"
        />
        {content}
      </summary>
      <CodePlate>{detail}</CodePlate>
    </details>
  );
}

/** Code-styled plate for tool input/output, summaries and stderr: capped at 24rem with its own scroll. */
export function CodePlate({ children }: { children: ReactNode }) {
  return (
    <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-code-border bg-code p-2 font-mono text-[0.8125rem] leading-[1.125rem] whitespace-pre-wrap [overflow-wrap:anywhere]">
      {children}
    </pre>
  );
}
