import { type AgentSummary, ApiError } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { archiveAgent, resyncAgent, unarchiveAgent } from "@/features/agents/api";
import { ShowOutput } from "@/features/agents/show-output";
import { agentDetailQueryOptions } from "@/features/session/api";
import { templateQueryOptions } from "@/features/templates/api";

const Mono = ({ children }: { children: ReactNode }) => (
  <code className="font-mono text-[0.8125rem]">{children}</code>
);
const linkClass = "underline underline-offset-4 decoration-current/40 hover:decoration-ring";

/** "Template x has errors." / "Template x no longer exists.", the name linking to the template. */
function TemplateProblem({ name, problem }: { name: string; problem: "invalid" | "missing" }) {
  return (
    <>
      Template{" "}
      <Link to="/templates/$name" params={{ name }} className={`font-mono ${linkClass}`}>
        {name}
      </Link>{" "}
      {problem === "invalid" ? "has errors." : "no longer exists."}
    </>
  );
}

/** "@a and @b report to this agent. Change their manager first.", each report linking to its
 *  edit page, where the manager is changed. */
function ReportsMessage({ reports }: { reports: string[] }) {
  return (
    <>
      {reports.map((r, i) => (
        <span key={r}>
          {i > 0 && (i === reports.length - 1 ? " and " : ", ")}
          <Link
            to="/agents/$slug/edit"
            params={{ slug: r }}
            className={`font-mono text-[0.8125rem] ${linkClass}`}
          >
            @{r}
          </Link>
        </span>
      ))}{" "}
      {reports.length === 1 ? "reports" : "report"} to this agent. Change their manager first.
    </>
  );
}

/** Whether the agent's template can be re-synced from; `unknown` while it loads. */
function useTemplateState(name: string): "ok" | "invalid" | "missing" | "unknown" {
  const q = useQuery({ ...templateQueryOptions(name), retry: false });
  if (q.data) {
    return !q.data.config || q.data.issues.some((i) => i.severity === "error") ? "invalid" : "ok";
  }
  if (q.error instanceof ApiError && q.error.code === "template_not_found") return "missing";
  return "unknown";
}

type Outcome = {
  tone: "success" | "error" | "pending";
  content: ReactNode;
  /** Set when the outcome replaced the focused control, so focus moves to the line. */
  focusKey?: number;
};

const pendingNote = async (
  qc: ReturnType<typeof useQueryClient>,
  slug: string,
): Promise<string> => {
  try {
    const d = await qc.fetchQuery(agentDetailQueryOptions(slug));
    return d.queue.some((q) => q.kind === "message")
      ? " Pending messages are sent with the next message."
      : "";
  } catch {
    return "";
  }
};

function ActionRow({
  title,
  text,
  action,
  reason,
  outcome,
}: {
  title: string;
  text: string;
  action: ReactNode;
  reason?: ReactNode;
  outcome?: Outcome;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="grid gap-0.5">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">{text}</p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-1 md:items-end">
          {action}
          {reason && (
            <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">{reason}</p>
          )}
        </div>
      </div>
      <InlineOutcome tone={outcome?.tone} focusKey={outcome?.focusKey}>
        {outcome?.content}
      </InlineOutcome>
    </div>
  );
}

/** Re-sync and Archive (or Restore, for an archived agent) under the Edit form. */
export function AgentActions({ agent }: { agent: AgentSummary }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const templateState = useTemplateState(agent.template);
  const [resyncOutcome, setResyncOutcome] = useState<Outcome>();
  const [lifeOutcome, setLifeOutcome] = useState<Outcome>();
  const [busy, setBusy] = useState<"resync" | "archive" | "restore">();
  const slug = agent.slug;
  const archived = agent.archivedAt !== null;
  const resyncBlocked = templateState === "invalid" || templateState === "missing";

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["agents"] }),
      qc.invalidateQueries({ queryKey: ["agent", slug] }),
    ]);

  async function resync() {
    if (busy || resyncBlocked) return;
    setBusy("resync");
    setResyncOutcome({ tone: "pending", content: "Re-syncing…" });
    try {
      const r = await resyncAgent(slug);
      // Staged while the agent runs: nothing looks applied before it is (spec §11.4).
      setResyncOutcome({
        tone: "success",
        content:
          r.applied === "on_restart" ? (
            `Re-synced. The changes apply when @${slug} restarts (when idle).`
          ) : r.backupDir ? (
            <>
              Re-synced. Previous files saved in <Mono>{r.backupDir}</Mono>.
            </>
          ) : (
            "Re-synced. Nothing differed."
          ),
      });
      void refresh();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === "template_invalid" || code === "template_missing") {
        setResyncOutcome({
          tone: "error",
          content: (
            <TemplateProblem
              name={agent.template}
              problem={code === "template_invalid" ? "invalid" : "missing"}
            />
          ),
        });
        void qc.invalidateQueries({ queryKey: ["templates", agent.template] });
      } else if (code === "plugin_install_failed") {
        setResyncOutcome({
          tone: "error",
          content: (
            <>
              Plugin install failed. Some files were already copied (previous versions in{" "}
              <Mono>state/agents/{slug}/resync/</Mono>). Fix the template and re-sync again.
              <ShowOutput output={(err as ApiError).body.output} />
            </>
          ),
        });
      } else {
        setResyncOutcome({
          tone: "error",
          content: err instanceof ApiError ? err.message : "Couldn't re-sync. Try again.",
        });
      }
    } finally {
      setBusy(undefined);
    }
  }

  async function archive() {
    if (busy) return;
    setBusy("archive");
    setLifeOutcome({ tone: "pending", content: `Archiving @${slug}…` });
    try {
      await archiveAgent(slug);
      // Leave first: refreshing this agent while the page is mounted would flash its archived
      // layout. The list refetches on arrival.
      await qc.invalidateQueries({ queryKey: ["agents"] });
      await navigate({ to: "/agents", search: { justArchived: slug } });
      void qc.invalidateQueries({ queryKey: ["agent", slug] });
    } catch (err) {
      const reports = err instanceof ApiError ? err.body.reports : undefined;
      setLifeOutcome({
        tone: "error",
        content:
          err instanceof ApiError && err.code === "has_reports" && Array.isArray(reports) ? (
            <ReportsMessage reports={reports.map(String)} />
          ) : err instanceof ApiError ? (
            err.message
          ) : (
            "Couldn't archive. Try again."
          ),
      });
      setBusy(undefined);
    }
  }

  async function restore() {
    if (busy) return;
    setBusy("restore");
    setLifeOutcome({ tone: "pending", content: `Restoring @${slug}…` });
    try {
      await unarchiveAgent(slug);
      const note = await pendingNote(qc, slug);
      await refresh();
      // Restore turns into Archive, so the focused button is gone: focus the line.
      setLifeOutcome({
        tone: "success",
        content: `Restored @${slug}.${note}`,
        focusKey: Date.now(),
      });
    } catch (err) {
      setLifeOutcome({
        tone: "error",
        content: err instanceof ApiError ? err.message : "Couldn't restore. Try again.",
      });
      // The fix is a new manager: take the user there.
      if (err instanceof ApiError && err.code === "manager_archived") {
        document.getElementById("field-reportsTo")?.focus();
      }
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section
      aria-labelledby="agent-actions-title"
      className="mt-10 grid max-w-xl gap-6 border-t border-border pt-6"
    >
      <h2 id="agent-actions-title" className="text-[0.8125rem] font-medium">
        Agent actions
      </h2>
      {!archived && (
        <ActionRow
          title="Re-sync from template"
          text="Copies the template's AGENTS.md, skills, files and settings over this agent's copies and reinstalls its plugins. Files that differ are backed up first."
          action={
            <Button
              type="button"
              variant="outline"
              aria-disabled={Boolean(busy) || resyncBlocked || undefined}
              onClick={() => void resync()}
            >
              Re-sync
            </Button>
          }
          reason={
            resyncBlocked && (
              <TemplateProblem
                name={agent.template}
                problem={templateState === "invalid" ? "invalid" : "missing"}
              />
            )
          }
          outcome={resyncOutcome}
        />
      )}
      {archived ? (
        <ActionRow
          title="Restore"
          text="Shows the agent in the list again. It starts with the next message it receives."
          action={
            <Button
              type="button"
              variant="outline"
              aria-disabled={Boolean(busy) || undefined}
              onClick={() => void restore()}
            >
              Restore
            </Button>
          }
          outcome={lifeOutcome}
        />
      ) : (
        <ActionRow
          title="Archive"
          text="Stops the agent now, ending any work in progress, and hides it. Its files and session are kept, and you can restore it."
          action={
            <Button
              type="button"
              variant="outline"
              aria-disabled={Boolean(busy) || undefined}
              onClick={() => void archive()}
            >
              {`Archive @${slug}`}
            </Button>
          }
          outcome={lifeOutcome}
        />
      )}
    </section>
  );
}

/** The list's line after an archive: "Archived @x. Undo", focused; Undo restores in place. */
export function UndoArchiveLine({
  slug,
  onRestored,
}: {
  slug: string;
  /** After a successful Undo, so the page can drop the one-shot `justArchived` from its URL. */
  onRestored?: () => void;
}) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>({
    tone: "success",
    content: `Archived @${slug}.`,
  });
  const [canUndo, setCanUndo] = useState(true);

  async function undo() {
    setCanUndo(false);
    setOutcome({ tone: "pending", content: `Restoring @${slug}…`, focusKey: 1 });
    try {
      await unarchiveAgent(slug);
      const note = await pendingNote(qc, slug);
      void qc.invalidateQueries({ queryKey: ["agents"] });
      setOutcome({ tone: "success", content: `Restored @${slug}.${note}`, focusKey: 2 });
      onRestored?.();
    } catch (err) {
      setOutcome({
        tone: "error",
        content: (
          <>
            {err instanceof ApiError ? err.message : "Couldn't restore. Try again."}{" "}
            <Link to="/agents/$slug/edit" params={{ slug }} className={linkClass}>
              Edit @{slug}
            </Link>
          </>
        ),
        focusKey: 3,
      });
    }
  }

  return (
    <InlineOutcome
      tone={outcome.tone}
      undo={canUndo ? () => void undo() : undefined}
      focusOnMount
      focusKey={outcome.focusKey}
    >
      {outcome.content}
    </InlineOutcome>
  );
}
