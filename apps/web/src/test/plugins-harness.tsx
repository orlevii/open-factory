import type { TemplateIssue } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentProps, type ReactNode, useState } from "react";
import type { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfigForm } from "@/features/config/config-form";
import { marketplaceRow, NO_CONTENTS, plugin } from "@/features/skills/fixtures";
import { doc } from "./config-harness";
import { json, mockApi } from "./mock-api";

/** The commit the Library read, and the older one a declaration is pinned to. */
export const LIB = "e4f5a6b".padEnd(40, "0");
export const PIN = "a1b2c3d".padEnd(40, "0");

export const source = { source: "github", repo: "acme/acme" } as const;
export const pinned = (ref?: string) => ({ source: { ...source, ...(ref ? { ref } : {}) } });

const withContents = { contentsSummary: { ...NO_CONTENTS, skills: 1 } };

/** acme (github, pinnable plugins and one that follows its source), a folder and a refused-source entry. */
export const MARKETPLACES = [
  marketplaceRow("acme", {
    source,
    commit: LIB,
    plugins: [
      plugin("review@acme", { ...withContents, version: "1.3.0" }),
      plugin("lint@acme", withContents),
      plugin("loose@acme", { pinnable: false, state: "cant_pin" }),
      plugin("sneaky@acme", { state: "refused", pinnable: false }),
    ],
  }),
  marketplaceRow("mine", {
    source: { source: "directory", path: "/home/me/plugins" },
    commit: null,
    plugins: [plugin("local@mine", withContents)],
  }),
  marketplaceRow("claude-plugins-official", {
    source: { source: "github", repo: "anthropics/claude-plugins-official" },
    commit: LIB,
    tags: { "v1.0.0": LIB },
    plugins: [plugin("docs@claude-plugins-official", withContents)],
  }),
];

export const useMarketplaces = (marketplaces: unknown = MARKETPLACES, more = {}) =>
  mockApi({
    "GET /api/library/marketplaces": () => json({ marketplaces }),
    "GET /api/library/skills": () => json({ hostDir: "/skills", groups: [] }),
    "GET /api/secrets": () => json({ secrets: [] }),
    "GET /api/templates": () => json({ dir: "/t", templates: [] }),
    ...more,
  });

/** The Configuration form over local state, the way the page drives it. */
export function PluginsForm({
  start = {},
  mode = "template",
  base,
  onValue,
  running,
  issues = [],
  children,
}: {
  start?: unknown;
  mode?: "agent" | "template";
  base?: ReturnType<typeof doc>;
  onValue?: (v: unknown) => void;
  running?: ComponentProps<typeof ConfigForm>["runningPlugins"];
  issues?: TemplateIssue[];
  children?: ReactNode;
}) {
  const [value, setValue] = useState<unknown>(start);
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ConfigForm
          mode={mode}
          value={value}
          base={mode === "agent" ? (base ?? doc()) : undefined}
          templateName="dev"
          issues={issues}
          runningPlugins={running}
          onChange={(u) =>
            setValue((p: unknown) => {
              const n = u(p);
              onValue?.(n);
              return n;
            })
          }
        />
        {children}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export const lastOf = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];
