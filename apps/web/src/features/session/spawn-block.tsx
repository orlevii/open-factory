import { CircleX, GitFork } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";
import { Tag } from "@/components/tag/tag";
import { formatBy } from "./format-by";
import { AgentLink, ClampedMarkdown } from "./message-block";
import { CallBlock, FailedNote } from "./outgoing-message";
import { QuietLine } from "./quiet-line";
import type { Row } from "./rows";
import { denialText } from "./tool-call-row";

type SpawnRow = Extract<Row, { kind: "spawn" }>;
type TerminateRow = Extract<Row, { kind: "terminate" }>;

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-foreground">{children}</span>
);

const spawnResultSchema = z.object({
  slug: z.string(),
  status: z.string(),
  note: z.string().optional(),
});

/** The tool's success result (`{ slug, agent_id, status, note? }`; the id is never shown), or
 *  undefined for an error or odd text. */
export function parseSpawnResult(result: SpawnRow["result"]) {
  if (!result || result.isError) return undefined;
  try {
    const r = spawnResultSchema.safeParse(JSON.parse(result.content));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Who did it, inside a sentence: a principal's tag is a chip showing its current handle; a word stays plain mono. */
export function Actor({ by }: { by: string }) {
  const b = formatBy(by);
  return b.kind === "tag" ? <Tag tagRef={b.ref} /> : <Mono>{by}</Mono>;
}

/** "by @lead" · "by @or" · "after 3 days without activity" (S7 UI design §4.4; never "@factory"). */
export function terminatedPhrase(by: string): ReactNode {
  if (formatBy(by).kind === "ttl") return "after 3 days without activity";
  return (
    <>
      by <Actor by={by} />
    </>
  );
}

/** The agent's own `spawn_agent` call (S7 UI design §4.1), on the outgoing-block shell: a GitFork
 *  sender line, the description as plain text, the brief as Markdown and a past-tense footer. */
export function SpawnBlock({
  slug,
  row,
  showCall,
  onToggleCall,
  rowProps,
}: {
  slug: string;
  row: SpawnRow;
  showCall: boolean;
  onToggleCall(): void;
  rowProps: Record<string, unknown>;
}) {
  const input = row.call.input as { template: string; description: string; prompt: string };
  const spawned = parseSpawnResult(row.result);
  const failed = row.result?.isError === true || !!row.denial;
  const tpl = input.template;
  const label = spawned
    ? `@${slug} spawned @${spawned.slug}`
    : failed
      ? `@${slug}'s spawn from ${tpl} failed`
      : row.result
        ? `@${slug} spawned from ${tpl}`
        : row.turnOpen
          ? `@${slug} is spawning from ${tpl}`
          : `@${slug}'s spawn from ${tpl} has no result`;
  return (
    <CallBlock
      row={row}
      label={label}
      showCall={showCall}
      onToggleCall={onToggleCall}
      rowProps={rowProps}
      sender={
        <>
          <GitFork aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span>
            <Mono>@{slug}</Mono>{" "}
            {spawned ? (
              <>
                <span className="text-muted-foreground">spawned</span>{" "}
                <AgentLink slug={spawned.slug} name />
              </>
            ) : (
              <>
                <span className="text-muted-foreground">spawn from template</span>{" "}
                <Mono>{tpl}</Mono>
              </>
            )}
          </span>
        </>
      }
      footer={failed ? <FailedNote row={row} /> : <Footer row={row} spawned={spawned} />}
    >
      {/* One muted line (S7 UI design §4.1): a long description ends in an ellipsis; the whole text
          stays in the DOM, so screen readers read it all. */}
      <p className="mb-1 truncate text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
        {input.description}
      </p>
      <ClampedMarkdown source={input.prompt} />
    </CallBlock>
  );
}

function Footer({ row, spawned }: { row: SpawnRow; spawned: ReturnType<typeof parseSpawnResult> }) {
  if (!row.result)
    return (
      <span>
        {row.turnOpen
          ? "Spawning…"
          : "No result: the turn ended before the spawn finished. Check the Agents list."}
      </span>
    );
  return (
    <>
      <span>
        {spawned?.status === "rate_limited" ? (
          <>
            Spawned · <span className="font-mono">@{spawned.slug}</span> was rate-limited
          </>
        ) : (
          "Spawned"
        )}
      </span>
      {spawned?.note && <span className="[overflow-wrap:anywhere]">{spawned.note}</span>}
    </>
  );
}

/** The agent's own `terminate_agent` call (S7 UI design §4.2): one quiet line with a CircleX. */
export function TerminateLine({
  row,
  rowProps,
}: {
  row: TerminateRow;
  rowProps: Record<string, unknown>;
}) {
  const target = (row.call.input as { slug: string }).slug.replace(/^@/, "");
  const who = <AgentLink slug={target} />;
  const failed = row.result?.isError === true || !!row.denial;
  let text: ReactNode;
  if (failed)
    text = (
      <span className="[overflow-wrap:anywhere]">
        Couldn't terminate {who}: {row.denial ? denialText(row.denial.reason) : row.result?.content}
      </span>
    );
  else if (row.result) text = <>Terminated {who}</>;
  else if (row.turnOpen) text = <>Terminating {who}…</>;
  else text = "No result: the turn ended before the terminate finished.";
  return (
    <QuietLine
      rowProps={rowProps}
      icon={<CircleX aria-hidden="true" className={failed ? "text-destructive" : undefined} />}
    >
      {text}
    </QuietLine>
  );
}
