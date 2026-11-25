import type { sourceUpdateViewSchema } from "@open-factory/shared";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type { z } from "zod";
import { UntrustedCode, UntrustedProse } from "@/components/untrusted-text";
import { TimeAgo } from "@/features/settings/shared";
import { SkeletonRows } from "./sections";

const GITHUB = "https://github.com/";

type View = z.infer<typeof sourceUpdateViewSchema>;
type Changed = View["changed"][number];

/** One `+` or `−` line of a diff: the sign, then the text as untrusted code. */
export function DiffLine({ sign, text }: { sign: "+" | "−"; text: string }) {
  return (
    <div className="flex gap-2">
      <span
        aria-hidden="true"
        className="select-none font-mono text-[0.8125rem] text-muted-foreground"
      >
        {sign}
      </span>
      <span className="sr-only">{sign === "+" ? "Added" : "Removed"}</span>
      <div className="min-w-0 flex-1">
        <UntrustedCode text={text} clampLines={200} />
      </div>
    </div>
  );
}

const hookText = (h: { event: string; matcher: string; command: string }) =>
  `${h.event}${h.matcher ? ` (${h.matcher})` : ""}: ${h.command}`;

function ChangedSkill({ c }: { c: Changed }) {
  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2 text-[0.8125rem]">
        <span className="font-mono">
          <UntrustedProse text={c.name} />
        </span>
        {c.runsCodeChanged && <span className="font-medium">Runs code changed</span>}
      </div>
      {c.hooks.removed.map((h) => (
        <DiffLine key={`-${hookText(h)}`} sign="−" text={hookText(h)} />
      ))}
      {c.hooks.added.map((h) => (
        <DiffLine key={`+${hookText(h)}`} sign="+" text={hookText(h)} />
      ))}
      {c.execFiles.map((f) => (
        <DiffLine key={`x${f}`} sign="+" text={f} />
      ))}
    </li>
  );
}

/** Skills that run code differently first, whatever order the server sent (a stable sort). */
const byRunsCode = (changed: Changed[]) =>
  [...changed].sort((a, b) => Number(b.runsCodeChanged) - Number(a.runsCodeChanged));

function NameList({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="text-[0.8125rem]">
      <p className="text-muted-foreground">{title}</p>
      <ul className="font-mono">
        {names.map((n) => (
          <li key={n}>
            <UntrustedProse text={n} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A source's update view (spec §6.3, §10.3): open in place under its Source section whenever an update exists. While the
 * detail is still building it (`view` undefined, `loading`) the section shows "Preparing update…" over static rows.
 * Results and the diff appear instantly. `outcome` and `action` are the Update button and its outcome line.
 */
export function UpdateView({
  from,
  to,
  view,
  loading,
  action,
}: {
  from: string | null;
  to: string | null;
  view: View | null | undefined;
  loading: boolean;
  action: ReactNode;
}) {
  const short = (s: string | null) => s?.slice(0, 7) ?? "";
  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-3">
      <p className="text-[0.8125rem]">
        <span className="font-mono">
          {short(view?.from ?? from)} → {short(view?.to ?? to)}
        </span>
        {view?.committedAt && (
          <>
            {" · "}
            <TimeAgo iso={view.committedAt} />
          </>
        )}
        {view?.subject && (
          <>
            {" · "}
            <UntrustedProse text={view.subject} />
          </>
        )}
      </p>
      {view?.compareUrl?.startsWith(GITHUB) && (
        <a
          href={view.compareUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[0.8125rem] underline underline-offset-2"
        >
          Compare on GitHub
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      )}
      {loading ? (
        <div role="status">
          <p className="mb-2 text-[0.8125rem] text-muted-foreground">Preparing update…</p>
          <SkeletonRows n={3} />
        </div>
      ) : view ? (
        <div className="space-y-3">
          {view.changed.length > 0 && (
            <ul className="space-y-2">
              {byRunsCode(view.changed).map((c) => (
                <ChangedSkill key={c.name} c={c} />
              ))}
            </ul>
          )}
          <NameList title="Removed" names={view.removed} />
          <NameList title="New in this commit, not added" names={view.added} />
          {view.unusable.length > 0 && (
            <NameList
              title="Unusable at this commit"
              names={view.unusable.map((u) => `${u.name}: ${u.detail}`)}
            />
          )}
        </div>
      ) : (
        <p className="text-[0.8125rem] text-muted-foreground">Can't show what changes.</p>
      )}
      <div>{action}</div>
    </div>
  );
}
