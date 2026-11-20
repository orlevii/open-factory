import type { templateSummarySchema } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { CircleAlert, TriangleAlert } from "lucide-react";
import type { z } from "zod";
import { ImageStatusLabel } from "./image-status";

type Summary = z.infer<typeof templateSummarySchema>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Plain words plus an icon; errors win when both exist. */
function ValidationState({ errors, warnings }: { errors: number; warnings: number }) {
  if (errors === 0 && warnings === 0) return null;
  const text =
    errors > 0
      ? warnings > 0
        ? `${plural(errors, "error")}, ${plural(warnings, "warning")}`
        : plural(errors, "error")
      : plural(warnings, "warning");
  const Icon = errors > 0 ? CircleAlert : TriangleAlert;
  return (
    <span className="order-2 ml-auto flex shrink-0 items-center gap-1.5 text-[0.8125rem] md:order-none">
      <Icon
        aria-hidden="true"
        className={errors > 0 ? "size-3.5 text-destructive" : "size-3.5 text-warning"}
      />
      {text}
    </span>
  );
}

export function TemplateList({ dir, templates }: { dir: string; templates: Summary[] }) {
  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No templates yet. Create one, or add a folder under{" "}
        <code className="font-mono text-[0.8125rem]">{dir.endsWith("/") ? dir : `${dir}/`}</code>.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border border-y border-border">
      {templates.map((t) => (
        <li key={t.name}>
          <Link
            to="/templates/$name"
            params={{ name: t.name }}
            className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-0.5 px-2 py-2 text-sm hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:flex-nowrap md:py-0"
          >
            <span className="font-mono text-[0.8125rem]">{t.name}</span>
            {t.displayName && <span className="shrink-0">{t.displayName}</span>}
            {/* The description is the first thing to go on narrow screens. */}
            <span className="hidden min-w-0 flex-1 truncate text-muted-foreground md:block">
              {t.description}
            </span>
            <span className="order-3 flex basis-full gap-4 text-[0.8125rem] text-muted-foreground md:order-none md:contents">
              {t.runtime && (
                <span className="md:shrink-0">{t.runtime === "docker" ? "Docker" : "Local"}</span>
              )}
              {t.imageStatus && (
                <span className="flex min-w-0 items-center gap-1.5 md:shrink-0">
                  <ImageStatusLabel status={t.imageStatus.status} />
                  {/* From md the cell doesn't shrink, so a long registry ref is capped here. */}
                  <span className="min-w-0 truncate font-mono md:max-w-56">
                    {t.imageStatus.name}
                  </span>
                </span>
              )}
              <span className="md:shrink-0">
                {t.agentCount === 0 ? "No agents" : plural(t.agentCount, "agent")}
              </span>
            </span>
            <ValidationState errors={t.errors} warnings={t.warnings} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
