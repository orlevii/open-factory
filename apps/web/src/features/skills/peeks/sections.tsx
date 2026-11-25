import { ApiError } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { CopyFailed, CopyIcon, useCopy } from "@/components/copy-feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A peek section: separated from the one above by a rule and spacing, never a card. `action` sits in the label row. */
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The pin as a copy button: the short sha, the full commit copied and carried in the tooltip and the accessible name. */
export function PinButton({ sha }: { sha: string }) {
  const { state, instant, copy } = useCopy();
  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            aria-label={`${state === "copied" ? "Copied" : "Copy commit"} ${sha}`}
            onClick={(e) => void copy(sha, e.detail === 0)}
            className="font-mono"
          >
            {sha.slice(0, 7)}
            <CopyIcon
              state={state}
              instant={instant}
              idle={<Copy aria-hidden="true" className="size-3" />}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="font-mono">{sha}</TooltipContent>
      </Tooltip>
      {state === "failed" && <CopyFailed />}
    </span>
  );
}

export function BackButton({ onBack }: { onBack(): void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack} className="shrink-0">
      <ArrowLeft aria-hidden="true" />
    </Button>
  );
}

/** `n` static rows at a real row's height, so a section doesn't jump when its content arrives. */
export function SkeletonRows({ n }: { n: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

const LINK = "underline underline-offset-2 hover:text-foreground";

/** "template dev, @ana and 2 more": at most three named, each a link to its page (where the fix is made). */
export function UsersLine({ templates, agents }: { templates: string[]; agents: string[] }) {
  const all = [
    ...templates.map((t) => ({ id: `t:${t}`, node: <TemplateLink name={t} /> })),
    ...agents.map((a) => ({
      id: `a:${a}`,
      node: (
        <Link to="/agents/$slug" params={{ slug: a }} className={LINK}>
          @{a}
        </Link>
      ),
    })),
  ];
  const named = all.slice(0, 3);
  return (
    <>
      {named.map((u, i) => (
        <span key={u.id}>
          {i > 0 && ", "}
          {u.node}
        </span>
      ))}
      {all.length > 3 && ` and ${all.length - 3} more`}
    </>
  );
}

export function TemplateLink({ name }: { name: string }) {
  return (
    <span>
      template{" "}
      <Link to="/templates/$name" params={{ name }} className={LINK}>
        {name}
      </Link>
    </span>
  );
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** An action's failure as one line: a refusal for users names them as links, anything else is the server's sentence. */
export function failure(err: unknown, fallback: string): ReactNode {
  if (!(err instanceof ApiError)) return fallback;
  const templates = strings(err.body.templates);
  const agents = strings(err.body.agents);
  const skills = strings(err.body.skills);
  if (err.code === "in_use")
    return (
      <>
        Used by <UsersLine templates={templates} agents={agents} />.
      </>
    );
  if (err.code === "update_drops_used")
    return (
      <>
        Update would remove {skills.length === 1 ? "skill" : "skills"} {skills.join(", ")}, used by{" "}
        <UsersLine templates={templates} agents={agents} />.
      </>
    );
  return err.message;
}
