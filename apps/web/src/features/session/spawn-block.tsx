import { CircleX, GitFork } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";
import { Tag } from "@/components/tag/tag";
import { useHandle } from "@/features/agents/use-agent-index";
import { useRefOfHandle } from "@/features/principals/use-principal";
import { formatBy } from "./format-by";
import { AgentLink, ClampedMarkdown } from "./message-block";
import { CallBlock, FailedNote } from "./outgoing-message";
import { QuietLine } from "./quiet-line";
import type { Row } from "./rows";
import { denialText } from "./tool-call-row";
import { refOfWho, whoHandle } from "./who";

type SpawnRow = Extract<Row, { kind: "spawn" }>;
type TerminateRow = Extract<Row, { kind: "terminate" }>;

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-foreground">{children}</span>
);

const spawnResultSchema = z.object({
  handle: z.string(),
  tag: z.string().optional(),
  status: z.string(),
  note: z.string().optional(),
});

/** The tool's success result (`{ handle, tag, agent_id, status, note? }`; the id is never shown), or
 *  undefined for an error or odd text. `ref` is the spawned agent's, read from its tag. */
export function parseSpawnResult(result: SpawnRow["result"]) {
  if (!result || result.isError) return undefined;
  try {
    const r = spawnResultSchema.safeParse(JSON.parse(result.content));
    if (!r.success) return undefined;
    const { tag, ...rest } = r.data;
    return { ...rest, ref: tag ? refOfWho(tag) : undefined };
  } catch {
    return undefined;
  }
}

/** An agent a tool call names by handle, tag or ref: a link when its ref is known, else its mono handle. */
function NamedAgent({ name, label = false }: { name: string; label?: boolean }) {
  const refOfHandle = useRefOfHandle();
  const bare = name.replace(/^@/, "");
  const ref = refOfWho(name) ?? refOfHandle(bare);
  if (ref) return <AgentLink agentRef={ref} name={label} />;
  return <Mono>@{whoHandle(name)}</Mono>;
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
  agentRef,
  row,
  showCall,
  onToggleCall,
  rowProps,
}: {
  agentRef: string;
  row: SpawnRow;
  showCall: boolean;
  onToggleCall(): void;
  rowProps: Record<string, unknown>;
}) {
  const input = row.call.input as { template: string; description: string; prompt: string };
  const spawned = parseSpawnResult(row.result);
  const failed = row.result?.isError === true || !!row.denial;
  const tpl = input.template;
  const handle = useHandle(agentRef);
  const label = spawned
    ? `@${handle} spawned @${spawned.handle}`
    : failed
      ? `@${handle}'s spawn from ${tpl} failed`
      : row.result
        ? `@${handle} spawned from ${tpl}`
        : row.turnOpen
          ? `@${handle} is spawning from ${tpl}`
          : `@${handle}'s spawn from ${tpl} has no result`;
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
            <Mono>@{handle}</Mono>{" "}
            {spawned ? (
              <>
                <span className="text-muted-foreground">spawned</span>{" "}
                {spawned.ref ? (
                  <AgentLink agentRef={spawned.ref} name />
                ) : (
                  <Mono>@{spawned.handle}</Mono>
                )}
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
            Spawned · <span className="font-mono">@{spawned.handle}</span> was rate-limited
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
  const target = (row.call.input as { target: string }).target;
  const who = <NamedAgent name={target} />;
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
