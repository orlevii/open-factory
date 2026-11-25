import type { ConfigDoc, TemplateIssue } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ConfigFormScope, type ConfigMode, type RawTarget } from "@/features/config/scope";

/** Test-only: a fresh query client per render (the pickers read host skills, secrets and templates through it). */
export function QueryWrap({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Test-only: a controlled scope over local state, the way the page drives it with `useConfigDraft`. */
export function ScopeHarness({
  mode = "agent",
  start,
  base,
  issues = [],
  conflicts,
  readOnly,
  onValue,
  onShowRaw,
  children,
}: {
  mode?: ConfigMode;
  start: unknown;
  base?: ConfigDoc | null;
  issues?: TemplateIssue[];
  conflicts?: string[];
  readOnly?: boolean;
  onValue?: (v: unknown) => void;
  onShowRaw?: (at: RawTarget) => void;
  children: ReactNode;
}) {
  const [value, setValue] = useState<unknown>(start);
  return (
    <QueryWrap>
      <ConfigFormScope
        mode={mode}
        value={value}
        base={base}
        templateName="dev"
        issues={issues}
        conflicts={conflicts}
        readOnly={readOnly}
        onShowRaw={onShowRaw}
        onChange={(u) =>
          setValue((prev: unknown) => {
            const next = u(prev);
            onValue?.(next);
            return next;
          })
        }
      >
        {children}
      </ConfigFormScope>
    </QueryWrap>
  );
}

export const doc = (
  template: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
): ConfigDoc => ({
  template,
  settings,
  mcp: { mcpServers: {} },
});
