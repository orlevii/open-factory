import type { AgentSummary } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentName } from "@/features/agents/agent-tree";
import { useAgent, useEndedAgent } from "@/features/agents/use-agent-index";
import { cn } from "@/lib/utils";

export type AgentChipAgent = Pick<
  AgentSummary,
  "slug" | "displayName" | "template" | "status" | "kind" | "avatarVersion"
>;

type Size = 16 | 20 | 24;

function isTruncated(root: HTMLElement): boolean {
  if (root.scrollWidth > root.clientWidth) return true;
  for (const el of root.querySelectorAll<HTMLElement>("*"))
    if (el.scrollWidth > el.clientWidth) return true;
  return false;
}

/** Wraps a truncating element. At rest it is a plain span; the Radix tooltip mounts only while a
 *  pointer or focus that found the content cut off stays, so a list of chips carries no tooltip roots. */
export function TruncTooltip({
  text,
  className,
  children,
}: {
  text: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [armed, setArmed] = useState(false);
  const check = () => {
    if (ref.current && isTruncated(ref.current)) setArmed(true);
  };
  const span = (
    // biome-ignore lint/a11y/noStaticElementInteractions: measures on hover/focus only; it adds no interaction
    <span
      ref={ref}
      onPointerEnter={check}
      onFocus={check}
      onPointerLeave={() => setArmed(false)}
      onBlur={() => setArmed(false)}
      className={cn("flex min-w-0", className)}
    >
      {children}
    </span>
  );
  if (!armed) return span;
  return (
    // Unmounted on leave or blur, not on close: Radix closes on pointer down, and dropping the
    // trigger then would swallow the click meant for an enclosing link.
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>{span}</TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

type Shown = {
  slug: string;
  displayName: string;
  kind?: AgentSummary["kind"];
  template?: string;
  avatarVersion?: string | null;
  status?: AgentSummary["status"];
  /** The name is the `@slug` stand-in: never repeat it as the slug. */
  stub?: boolean;
};

function ChipView({
  a,
  size,
  showSlug,
  badge,
  link,
  className,
}: {
  a: Shown;
  size: Size;
  showSlug: boolean;
  badge: boolean;
  link: boolean;
  className?: string;
}) {
  const classes = cn(
    "inline-flex min-w-0 items-center gap-1.5 @max-[24rem]:flex-col @max-[24rem]:items-start @max-[24rem]:gap-0",
    link && "rounded-sm hover:underline",
    className,
  );
  // Each line is capped at the chip's width: stacked (items-start), a line would otherwise size to
  // its content and the name would never truncate.
  const body = (
    <>
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <AgentAvatar
          slug={a.slug}
          template={a.template}
          avatarVersion={a.avatarVersion}
          size={size}
          status={badge ? a.status : undefined}
        />
        <TruncTooltip text={a.displayName} className="min-w-[min(8rem,45%)]">
          <AgentName agent={{ displayName: a.displayName, kind: a.kind ?? "persistent" }} />
        </TruncTooltip>
      </span>
      {showSlug && !a.stub ? (
        <TruncTooltip
          text={`@${a.slug}`}
          className="min-w-24 max-w-full font-mono text-muted-foreground @max-[24rem]:text-xs"
        >
          <MiddleTruncate text={`@${a.slug}`} />
        </TruncTooltip>
      ) : null}
    </>
  );
  if (link)
    return (
      <Link to="/agents/$slug" params={{ slug: a.slug }} className={classes}>
        {body}
      </Link>
    );
  return <span className={classes}>{body}</span>;
}

type ChipProps = {
  size?: Size;
  showSlug?: boolean;
  badge?: boolean;
  /** Wrap the chip in a link to the agent's page. Never inside another link (a task-list row). */
  link?: boolean;
  className?: string;
};

function SlugChip({
  slug,
  name,
  size = 20,
  showSlug = false,
  badge = false,
  link = false,
  className,
}: ChipProps & { slug: string; name?: string }) {
  const live = useAgent(slug);
  const ended = useEndedAgent(slug);
  const found = live ?? ended;
  const a: Shown = found ?? { slug, displayName: name ?? `@${slug}`, stub: !name };
  return (
    <ChipView
      a={a}
      size={size}
      showSlug={showSlug}
      badge={badge}
      link={link}
      className={className}
    />
  );
}

/** Avatar, display name and optionally the muted `@slug`. Pass the agent when you have it; pass
 *  `slug` to resolve it from the cached lists (live, then ended), else the slug stands in. */
export function AgentChip(
  props: ({ agent: AgentChipAgent } | { slug: string; name?: string }) & ChipProps,
) {
  if ("agent" in props) {
    const { agent, size = 20, showSlug = false, badge = false, link = false, className } = props;
    return (
      <ChipView
        a={agent}
        size={size}
        showSlug={showSlug}
        badge={badge}
        link={link}
        className={className}
      />
    );
  }
  return <SlugChip {...props} />;
}

export function PrincipalChip({
  principal,
  size,
  link,
}: {
  principal: { kind: "agent"; slug: string } | { kind: "user"; handle: string };
  size?: Size;
  /** Links an agent to its page; a human has none. */
  link?: boolean;
}) {
  if (principal.kind === "agent")
    return <AgentChip slug={principal.slug} size={size} link={link} />;
  return <span className="min-w-0 truncate">@{principal.handle}</span>;
}
