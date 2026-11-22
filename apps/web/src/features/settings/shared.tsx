import type { CredentialKind } from "@open-factory/shared";
import { Link, useRouter } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export const linkClass = "underline underline-offset-4 decoration-current/40 hover:decoration-ring";
export const monoClass = "font-mono text-[0.8125rem]";
export const smallClass = "text-[0.8125rem] leading-[1.125rem]";

export const KIND_LABEL: Record<CredentialKind, string> = {
  oauth_token: "OAuth token",
  api_key: "API key",
};

/** "@a", "@a and @b", "@a, @b and @c". */
export const tags = (slugs: string[]) => {
  const t = slugs.map((s) => `@${s}`);
  return t.length <= 1 ? (t[0] ?? "") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
};

/** "@lead restarts when idle to use it. Its crons from this session stop." */
export const restartNote = (slugs: string[]) =>
  slugs.length === 0
    ? ""
    : slugs.length === 1
      ? `${tags(slugs)} restarts when idle to use it. Its crons from this session stop.`
      : `${tags(slugs)} restart when idle to use it. Their crons from this session stop.`;

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];
/** "2 hours ago", "yesterday", "just now". A time ahead of this clock (skew) reads "just now". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.min(Math.round((new Date(iso).getTime() - now) / 1000), 0);
  if (Math.abs(s) < 45) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(s) >= size || unit === "minute") return rtf.format(Math.round(s / size), unit);
  }
  return "just now";
}

/** A relative time with the absolute one as its title. */
export function TimeAgo({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {ago(iso)}
    </time>
  );
}

/** Server copy marks commands with backticks ("`claude setup-token`"): render them as code. */
export function CodeText({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <code key={i} className={monoClass}>
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** Agent handles as links, joined "@a, @b". `edit` links to the edit page (where a fix is made). */
export function AgentLinks({ slugs, edit }: { slugs: string[]; edit?: boolean }) {
  return (
    <>
      {slugs.map((s, i) => (
        <span key={s}>
          {i > 0 && ", "}
          {edit ? (
            <Link
              to="/agents/$slug/edit"
              params={{ slug: s }}
              className={`${monoClass} ${linkClass}`}
            >
              @{s}
            </Link>
          ) : (
            <Link to="/agents/$slug" params={{ slug: s }} className={`${monoClass} ${linkClass}`}>
              @{s}
            </Link>
          )}
        </span>
      ))}
    </>
  );
}

/** "Used by @a, @b" / "Not used", with archived users appended as "· archived: @c". */
export function Usage({
  active,
  archived = [],
  verb,
  none,
}: {
  active: string[];
  archived?: string[];
  verb: string;
  none: string;
}) {
  return (
    <span className={`${smallClass} text-muted-foreground`}>
      {active.length > 0 ? (
        <>
          {verb} <AgentLinks slugs={active} />
        </>
      ) : (
        none
      )}
      {archived.length > 0 && (
        <>
          {" · archived: "}
          <AgentLinks slugs={archived} />
        </>
      )}
    </span>
  );
}

/** One settings section: the panel-heading h2, an optional muted line, then its content. */
export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="grid min-w-0 scroll-mt-6 grid-cols-[minmax(0,1fr)] gap-3"
    >
      <div className="grid gap-0.5">
        <h2
          id={`${id}-title`}
          tabIndex={-1}
          className="text-[0.8125rem] font-medium outline-none" // ui-contract:allow programmatic focus target, not interactive
        >
          {title}
        </h2>
        {description && <p className={`${smallClass} text-muted-foreground`}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function SettingsList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border border-y border-border">{children}</ul>;
}

/** The first line of a row: the name, its facts, then the actions at the right edge. */
export function RowLine({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
      {children}
      <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  );
}

export function RowName({ children }: { children: ReactNode }) {
  return <span className={`${monoClass} min-w-0 break-all md:w-36 md:shrink-0`}>{children}</span>;
}

/** The `⋯` button that opens a row's menu (rendered as the Radix trigger's child). */
export function MoreButton({
  label,
  id,
  ...props
}: { label: string; id: string } & ComponentProps<typeof Button>) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" id={id} aria-label={label} {...props}>
      <Ellipsis aria-hidden="true" />
    </Button>
  );
}

/** Focus an element by id after the next render (the element may be about to mount). */
export function useFocusLater() {
  const target = useRef<string | null>(null);
  useEffect(() => {
    if (!target.current) return;
    const el = document.getElementById(target.current);
    if (el) {
      target.current = null;
      el.focus();
    }
  });
  return useCallback((id: string) => {
    target.current = id;
  }, []);
}

/** Focus an outcome line's Undo, or the line itself. */
export function focusOutcome(containerId: string) {
  const c = document.getElementById(containerId);
  (
    c?.querySelector<HTMLElement>("button") ?? c?.querySelector<HTMLElement>("[tabindex='-1']")
  )?.focus();
}

/** An inline add or replace form: focuses its first field, Escape or Cancel closes it. */
export function InlineForm({
  label,
  onSubmit,
  onCancel,
  children,
  submitLabel,
  pendingLabel,
  pending,
  formError,
  autoFocusId,
  reveal = false,
}: {
  label: string;
  onSubmit(): void;
  onCancel(): void;
  children: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  formError?: string;
  /** The field to focus on open, when it isn't the first one (a prefilled name). */
  autoFocusId?: string;
  /** Opened by a link (?addSecret): bring the whole form into view, wherever it sits on the page. */
  reveal?: boolean;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, when the form opens
  useEffect(() => {
    const first = autoFocusId
      ? document.getElementById(autoFocusId)
      : ref.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea");
    first?.focus({ preventScroll: reveal });
    if (!reveal) return;
    const show = () => ref.current?.scrollIntoView?.({ block: "nearest" });
    show();
    // The navigation that opened the form resets the page to the top once it has rendered, which
    // is after this effect: show the form again then. Only that one navigation.
    const off = router.subscribe("onRendered", () => {
      off();
      show();
    });
    return off;
  }, []);
  return (
    <form
      ref={ref}
      aria-label={label}
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!pending) onSubmit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !pending) {
          e.preventDefault();
          onCancel();
        }
      }}
      className="grid max-w-xl gap-4 py-3"
    >
      {children}
      <div className="grid gap-2">
        <div role="alert" className={`${smallClass} text-destructive empty:hidden`}>
          {formError}
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="lg" aria-disabled={pending || undefined}>
            {pending && <Spinner />}
            {pending ? pendingLabel : submitLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            aria-disabled={pending || undefined}
            onClick={() => !pending && onCancel()}
          >
            Cancel
          </Button>
          <span role="status" className="sr-only">
            {pending ? pendingLabel : ""}
          </span>
        </div>
      </div>
    </form>
  );
}
