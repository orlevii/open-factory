import type { TaskLink } from "@open-factory/shared";
import { ArrowUpRight } from "lucide-react";
import { AgentLink, LINK_CLASS } from "@/features/session/message-block";

const KIND = { url: "URL", pr: "PR", file: "File", agent: "Agent" } as const;

const bare = (url: string) => url.replace(/^https?:\/\//, "");

/** UI design §8.3's display. Agent-written text (titles, targets) is plain text; `href`s are validated http(s) only. */
export function LinkList({ links }: { links: TaskLink[] }) {
  if (!links.length) return <p className="text-[0.8125rem] text-muted-foreground">None</p>;
  return (
    <ul aria-label="Links" className="grid gap-1.5 text-[0.8125rem] leading-[1.125rem]">
      {links.map((l, i) => (
        // Links have no id of their own; the list is replaced as a whole.
        // biome-ignore lint/suspicious/noArrayIndexKey: order is the identity
        <li key={i} className="flex min-w-0 gap-3">
          <span className="w-10 shrink-0 text-muted-foreground">{KIND[l.kind]}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {l.kind === "agent" && l.agent ? (
              <>
                <AgentLink agentRef={l.agent.ref} />
                {l.agent.ended && <span className="text-muted-foreground"> · {l.agent.ended}</span>}
              </>
            ) : l.kind === "file" || !/^https?:\/\//.test(l.target ?? "") ? (
              // A file path, or (never expected) a target that isn't http(s): text, never a link.
              <span className={l.kind === "file" ? "font-mono" : undefined}>{l.target}</span>
            ) : (
              <a
                href={l.target}
                target="_blank"
                rel="noreferrer noopener"
                className={`inline-flex items-center gap-0.5 text-foreground ${LINK_CLASS}`}
              >
                {l.title ?? bare(l.target ?? "")}
                <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
