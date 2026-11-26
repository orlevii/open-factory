import type { AgentStatus } from "@open-factory/shared";
import { CircleAlert } from "lucide-react";
import { type CSSProperties, memo, useState } from "react";
import { type BotParts, botParts } from "../lib/factory-bot";

/** Parts are a pure function of the agent's ref (stable across renames), so one result serves every avatar of that agent. */
const PARTS = new Map<string, BotParts>();
export function partsFor(agentRef: string): BotParts {
  let p = PARTS.get(agentRef);
  if (!p) {
    p = botParts(agentRef);
    PARTS.set(agentRef, p);
  }
  return p;
}

// Shapes live in a 24x24 box, integer coordinates only.
const HEADS = [
  <polygon key="h" points="6,3 18,3 23,12 18,21 6,21 1,12" />,
  <circle key="c" cx="12" cy="12" r="10" />,
  <rect key="r" x="2" y="2" width="20" height="20" rx="5" />,
  <polygon key="o" points="8,2 16,2 22,8 22,16 16,22 8,22 2,16 2,8" />,
];
const EYES = [
  <g key="e0">
    <circle cx="8" cy="10" r="2" />
    <circle cx="16" cy="10" r="2" />
  </g>,
  <g key="e1">
    <rect x="6" y="8" width="4" height="4" />
    <rect x="14" y="8" width="4" height="4" />
  </g>,
  <rect key="e2" x="5" y="9" width="14" height="3" rx="1" />,
  <g key="e3">
    <rect x="7" y="7" width="2" height="6" />
    <rect x="15" y="7" width="2" height="6" />
  </g>,
  <g key="e4">
    <circle cx="12" cy="10" r="3" />
  </g>,
  <g key="e5">
    <polygon points="6,12 10,12 8,8" />
    <polygon points="14,12 18,12 16,8" />
  </g>,
];
const MOUTHS = [
  <rect key="m0" x="8" y="15" width="8" height="2" />,
  <rect key="m1" x="10" y="15" width="4" height="3" />,
  <polygon key="m2" points="8,15 16,15 12,18" />,
  <g key="m3">
    <rect x="8" y="16" width="2" height="2" />
    <rect x="11" y="16" width="2" height="2" />
    <rect x="14" y="16" width="2" height="2" />
  </g>,
];
const ACCESSORIES = [
  null,
  <rect key="a1" x="11" y="0" width="2" height="3" />,
  <g key="a2">
    <rect x="0" y="9" width="2" height="6" />
    <rect x="22" y="9" width="2" height="6" />
  </g>,
  <polygon key="a3" points="9,3 12,0 15,3" />,
  <g key="a4">
    <rect x="8" y="0" width="2" height="3" />
    <rect x="14" y="0" width="2" height="3" />
  </g>,
];

const BotSvg = memo(function BotSvg({
  agentRef,
  color,
  size,
}: {
  agentRef: string;
  color: number | null;
  size: number;
}) {
  const p = partsFor(agentRef);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      className="absolute inset-0 overflow-visible"
    >
      <g fill={`var(--avatar-${color ?? p.fill})`} stroke="var(--border)" strokeWidth="1">
        {HEADS[p.head]}
      </g>
      <g fill="var(--avatar-ink)">
        {EYES[p.eyes]}
        {MOUTHS[p.mouth]}
        {ACCESSORIES[p.accessory]}
      </g>
    </svg>
  );
});

const TOOTH_SM = [4, 8] as const;
const TOOTH_LG = [6, 12] as const;

/** The status shape that doubles as the avatar badge: shape, never colour alone. Null at rest. */
export function StatusMark({
  status,
  size,
  tooth = TOOTH_LG,
  glyph = size * 2,
}: {
  status: AgentStatus;
  /** Diameter of the dot and the ring. */
  size: number;
  /** Width and height of the working tooth. */
  tooth?: readonly [number, number];
  /** Box of the errored glyph (StatusBadge draws it at twice the dot). */
  glyph?: number;
}) {
  const box = { width: size, height: size } satisfies CSSProperties;
  switch (status) {
    case "working":
      return (
        <span
          data-status-mark={status}
          style={{ width: tooth[0], height: tooth[1] }}
          className="of-tooth"
        />
      );
    case "errored":
      return (
        <CircleAlert
          data-status-mark={status}
          aria-hidden="true"
          width={glyph}
          height={glyph}
          className="fill-destructive stroke-card text-destructive"
        />
      );
    case "rate_limited":
      return (
        <span
          data-status-mark={status}
          data-status-dot
          style={box}
          className="rounded-full bg-warning transition-[background-color] duration-150"
        />
      );
    case "queued":
      return (
        <span
          data-status-mark={status}
          style={{ ...box, borderColor: "var(--status-queued)" }}
          className="rounded-full border-[1.5px] border-solid transition-[border-color] duration-150"
        />
      );
    default:
      return null;
  }
}

/** Statuses that draw a badge; the rest (idle, hibernated, terminated) draw nothing and cut no hole. */
const MARKED: ReadonlySet<AgentStatus> = new Set(["working", "errored", "rate_limited", "queued"]);

/** Badge geometry per avatar size (spec §5.1): the badge's box (its longest side) and the shape's sizes. */
function badgeFor(status: AgentStatus, avatar: 16 | 20 | 24) {
  const dot = avatar === 16 ? 4 : 6;
  const tooth = avatar < 24 ? TOOTH_SM : TOOTH_LG;
  const box = status === "working" ? tooth[1] : dot;
  return { dot, tooth, box };
}

export const AgentAvatar = memo(function AgentAvatar({
  agentRef,
  template,
  avatarVersion,
  color,
  size,
  status,
}: {
  agentRef: string;
  template?: string;
  avatarVersion?: string | null;
  /** The chosen identity colour 1..12, null for Auto (seeded from the agentRef). Required so no call site forgets it. */
  color: number | null;
  size: 16 | 20 | 24;
  status?: AgentStatus;
}) {
  const src =
    template && avatarVersion
      ? `/api/templates/${encodeURIComponent(template)}/avatar.svg?v=${encodeURIComponent(avatarVersion)}`
      : null;
  const badge = status && MARKED.has(status) ? badgeFor(status, size) : null;
  return (
    <span
      data-agent-avatar
      aria-hidden="true"
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      <span
        className={badge ? "of-avatar-cut absolute inset-0" : "absolute inset-0"}
        style={
          badge
            ? ({ "--mark": `${badge.box}px`, "--hole": `${badge.box + 2}px` } as CSSProperties)
            : undefined
        }
      >
        <BotSvg agentRef={agentRef} color={color} size={size} />
        {src ? <OverrideImg key={src} src={src} /> : null}
      </span>
      {status && badge ? (
        <span
          className="absolute flex items-center justify-center"
          style={{ right: 0, bottom: 0, width: badge.box, height: badge.box }}
        >
          <StatusMark status={status} size={badge.dot} tooth={badge.tooth} glyph={badge.dot} />
        </span>
      ) : null}
    </span>
  );
});

/** Keyed on `src` by the parent, so a new version starts with `failed` reset. */
function OverrideImg({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      onError={() => setFailed(true)}
      className="absolute inset-0 size-full rounded-full bg-card object-contain"
    />
  );
}
