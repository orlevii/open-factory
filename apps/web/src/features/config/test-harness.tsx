import type { ConfigDoc, TemplateIssue } from "@open-factory/shared";
import { type ReactNode, useState } from "react";
import { ConfigFormScope, type ConfigMode, type RawTarget } from "./scope";

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
