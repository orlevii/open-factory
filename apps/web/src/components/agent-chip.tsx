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
  "slug" | "displayName" | "template" | "status" | "kind" | "avatarVersion" | "color"
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
  dir,
  alsoWhen,
  children,
}: {
  text: string;
  className?: string;
  /** "auto" for names: a right-to-left name sets its own direction (bidi). */
  dir?: "auto";
  /** Another reason to show the tooltip, checked on hover or focus (a chip's hidden handle). */
  alsoWhen?(el: HTMLElement): boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [armed, setArmed] = useState(false);
  const check = () => {
    const el = ref.current;
    if (el && (isTruncated(el) || alsoWhen?.(el))) setArmed(true);
  };
  const span = (
    // biome-ignore lint/a11y/noStaticElementInteractions: measures on hover/focus only; it adds no interaction
    <span
      ref={ref}
      onPointerEnter={check}
      onFocus={check}
      onPointerLeave={() => setArmed(false)}
      onBlur={() => setArmed(false)}
      dir={dir}
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

/** What a chip shows: a full summary, or a projection of one (a speaker index, U3 §7.2). */
export type ChipAgent = {
  slug: string;
  displayName: string;
  kind?: AgentSummary["kind"];
  template?: string;
  avatarVersion?: string | null;
  color?: number | null;
  status?: AgentSummary["status"];
  /** The name is the `@slug` stand-in: never repeat it as the slug. */
  stub?: boolean;
};

/** The chip's handle is hidden (a narrow speaker line hides it below 20rem): the name's tooltip
 *  carries it instead. */
const slugHidden = (name: HTMLElement) => {
  // The chip's second line: the name's line comes first.
  const slug = name.closest("[data-chip]")?.children[1];
  return !!slug && slug.getClientRects().length === 0;
};

function ChipView({
  a,
  size,
  showSlug,
  badge,
  link,
  inline,
  handleInTooltip,
  className,
  slugClassName,
}: {
  a: ChipAgent;
  size: Size;
  showSlug: boolean;
  badge: boolean;
  link: boolean;
  inline: boolean;
  handleInTooltip: boolean;
  className?: string;
  slugClassName?: string;
}) {
  const classes = cn(
    "inline-flex min-w-0 items-center gap-1.5",
    !inline && "@max-[24rem]:flex-col @max-[24rem]:items-start @max-[24rem]:gap-0",
    link && "rounded-sm hover:underline",
    className,
  );
  const slugShown = showSlug && !a.stub;
  // The handle without its own line: only in the name's tooltip.
  const tipHandle = handleInTooltip && !slugShown && !a.stub;
  // Each line is capped at the chip's width: stacked (items-start), a line would otherwise size to
  // its content and the name would never truncate.
  const body = (
    <>
      <span className="flex min-w-0 max-w-full items-center gap-1.5">
        <AgentAvatar
          slug={a.slug}
          template={a.template}
          avatarVersion={a.avatarVersion}
          color={a.color ?? null}
          size={size}
          status={badge ? a.status : undefined}
        />
        <TruncTooltip
          text={slugShown || tipHandle ? `${a.displayName} @${a.slug}` : a.displayName}
          dir="auto"
          className="min-w-[min(8rem,45%)]"
          {...(slugShown ? { alsoWhen: slugHidden } : tipHandle ? { alsoWhen: () => true } : {})}
        >
          <AgentName agent={{ displayName: a.displayName, kind: a.kind ?? "persistent" }} />
        </TruncTooltip>
      </span>
      {slugShown ? (
        <TruncTooltip
          text={`@${a.slug}`}
          className={cn(
            "max-w-full font-mono text-muted-foreground",
            !inline && "@max-[24rem]:text-xs",
            slugClassName,
          )}
        >
          <MiddleTruncate text={`@${a.slug}`} />
        </TruncTooltip>
      ) : null}
    </>
  );
  if (link)
    return (
      <Link data-chip to="/agents/$slug/chat" params={{ slug: a.slug }} className={classes}>
        {body}
      </Link>
    );
  return (
    <span data-chip className={classes}>
      {body}
    </span>
  );
}

type ChipProps = {
  size?: Size;
  showSlug?: boolean;
  badge?: boolean;
  /** Wrap the chip in a link to the agent's page. Never inside another link (a task-list row). */
  link?: boolean;
  className?: string;
  /** Extra classes for the `@slug` (a speaker line hides it below a 20rem container). */
  slugClassName?: string;
  /** Name and handle stay on one line at any width, truncating (a speaker line); otherwise the
   *  chip stacks them below a 24rem container. */
  inline?: boolean;
  /** The handle shows in the name's tooltip, with no line of its own (a list row's chip). */
  handleInTooltip?: boolean;
};

function SlugChip({
  slug,
  name,
  size = 20,
  showSlug = false,
  badge = false,
  link = false,
  inline = false,
  handleInTooltip = false,
  className,
  slugClassName,
}: ChipProps & { slug: string; name?: string }) {
  const live = useAgent(slug);
  const ended = useEndedAgent(slug);
  const found = live ?? ended;
  const a: ChipAgent = found ?? { slug, displayName: name ?? `@${slug}`, stub: !name };
  return (
    <ChipView
      a={a}
      size={size}
      showSlug={showSlug}
      badge={badge}
      link={link}
      inline={inline}
      handleInTooltip={handleInTooltip}
      className={className}
      slugClassName={slugClassName}
    />
  );
}

/** Avatar, display name and optionally the muted `@slug`. Pass the agent when you have it; pass
 *  `slug` to resolve it from the cached lists (live, then ended), else the slug stands in. */
export function AgentChip(
  props: ({ agent: AgentChipAgent | ChipAgent } | { slug: string; name?: string }) & ChipProps,
) {
  if ("agent" in props) {
    const {
      agent,
      size = 20,
      showSlug = false,
      badge = false,
      link = false,
      inline = false,
      handleInTooltip = false,
      className,
      slugClassName,
    } = props;
    return (
      <ChipView
        a={agent}
        size={size}
        showSlug={showSlug}
        badge={badge}
        link={link}
        inline={inline}
        handleInTooltip={handleInTooltip}
        className={className}
        slugClassName={slugClassName}
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
  principal: { kind: "agent" | "human"; ref: string; handle: string };
  size?: Size;
  /** Links an agent to its page; a human has none. */
  link?: boolean;
}) {
  if (principal.kind === "agent")
    return <AgentChip slug={principal.handle} size={size} link={link} />;
  return <span className="min-w-0 truncate">@{principal.handle}</span>;
}
