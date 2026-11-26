import type { PrincipalItem } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, use } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { HumanAvatar } from "@/components/human-avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePrincipal } from "@/features/principals/use-principal";
import { cn } from "@/lib/utils";

/** Set by a link (or any other control) around markdown: a chip inside it can't be a link of its own. */
export const InsideLinkContext = createContext(false);

const ENDED = { archived: "Archived", terminated: "Terminated", disabled: "Disabled" } as const;
const NOBODY = "No one in this factory has this tag";

const CHIP =
  "inline rounded-[4px] bg-muted px-px font-medium dark:bg-selected [&_[data-agent-avatar]]:align-[-0.2em] [&_[data-human-avatar]]:align-[-0.2em]";
const HOVER =
  "rounded-[4px] [@media(hover:hover)_and_(pointer:fine)]:transition-colors [@media(hover:hover)_and_(pointer:fine)]:duration-150 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-accent dark:[@media(hover:hover)_and_(pointer:fine)]:hover:bg-[color-mix(in_oklch,var(--selected),var(--foreground)_6%)]";
const Sr = ({ children }: { children: ReactNode }) => <span className="sr-only">{children}</span>;

/** `@` and the handle's first segment stay together with the avatar; the rest may break at its hyphens. */
function Handle({ p, ended }: { p: PrincipalItem; ended: boolean }) {
  const dash = p.handle.indexOf("-");
  const first = dash < 0 ? p.handle : p.handle.slice(0, dash);
  const rest = dash < 0 ? "" : p.handle.slice(dash);
  return (
    <>
      <span className="whitespace-nowrap">
        <span aria-hidden="true" className={cn("mr-[0.2em] inline-block", ended && "opacity-50")}>
          {p.kind === "human" ? (
            <HumanAvatar name={p.name} size={16} />
          ) : (
            <AgentAvatar
              slug={p.handle}
              template={p.avatar?.template}
              avatarVersion={p.avatar?.avatarVersion}
              color={p.avatar?.color ?? null}
              size={16}
            />
          )}
        </span>
        @{first}
      </span>
      {rest}
    </>
  );
}

function FoundTag({ p, interactive }: { p: PrincipalItem; interactive: boolean }) {
  const ended = p.state !== "live";
  const cls = cn(CHIP, ended && "text-muted-foreground");
  const body = (
    <>
      <Handle p={p} ended={ended} />
      <Sr>
        , {p.name}
        {ended ? `, ${p.state}` : ""}
      </Sr>
    </>
  );
  const marks = { "data-of-tag": p.ref, "data-handle": p.handle };
  if (!interactive)
    return (
      <span className={cls} {...marks}>
        {body}
      </span>
    );
  const tip = `${p.name} · ${ended ? ENDED[p.state as keyof typeof ENDED] : p.kind === "agent" ? "Agent" : "Person"}`;
  const trigger =
    p.kind === "agent" ? (
      <Link
        to="/agents/$slug/chat"
        // Until the route is keyed by ref, the slug is the handle.
        params={{ slug: p.handle }}
        className={cn(cls, HOVER)}
        {...marks}
      >
        {body}
      </Link>
    ) : (
      <span className={cls} {...marks}>
        {body}
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** A `<@ref>` as a chip showing the principal's current handle. `interactive={false}` (inside a link) keeps the look only. */
export function Tag({ tagRef, interactive = true }: { tagRef: string; interactive?: boolean }) {
  const found = usePrincipal(tagRef);
  if (found.status === "found") return <FoundTag p={found.principal} interactive={interactive} />;
  if (found.status === "pending")
    return (
      <span className={CHIP}>
        <span
          aria-hidden="true"
          className="mr-[0.2em] inline-block size-4 rounded-full border border-border bg-card align-[-0.2em]"
        />
        @…
      </span>
    );
  const unknown = (
    <span className={cn(CHIP, "text-muted-foreground")}>
      @unknown
      <Sr>, {NOBODY}</Sr>
    </span>
  );
  if (!interactive) return unknown;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{unknown}</TooltipTrigger>
      <TooltipContent>{NOBODY}</TooltipContent>
    </Tooltip>
  );
}

/** What `Markdown` renders for an `of-tag` element. */
export function MarkdownTag({ tagRef }: { tagRef?: string }) {
  const inside = use(InsideLinkContext);
  return tagRef ? <Tag tagRef={tagRef} interactive={!inside} /> : null;
}
