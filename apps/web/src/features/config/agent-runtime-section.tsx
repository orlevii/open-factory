import { type AgentSummary, ApiError } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FieldShell } from "@/components/field-shell";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { updateAgent } from "@/features/agents/api";
import { factorySettingsQueryOptions } from "@/features/settings/api";
import { AGENT_RUNTIME_COPY, RUNTIME_COPY } from "./messages";
import { Section } from "./section";

type Runtime = AgentSummary["runtime"];
const LABEL: Record<Runtime, string> = { docker: "Docker", local: "Local" };

/**
 * Where this agent runs. Not part of the form's draft: a switch is its own act, saved at once, and it restarts the
 * agent. A template's runtime only applies to new agents. Leaving the sandbox widens what the agent can reach and what
 * it does on the host can't be undone, so Local asks first; back to Docker is safe and undoable, so it doesn't
 * (DESIGN.md: don't confirm an action that can be undone).
 */
export function AgentRuntimeSection({
  agent,
  templateRuntime,
  templateBypass,
}: {
  agent: AgentSummary;
  templateRuntime: string | undefined;
  templateBypass: boolean;
}) {
  const qc = useQueryClient();
  const factory = useQuery(factorySettingsQueryOptions).data;
  const name = useId();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string>();
  const current = agent.runtime;
  const localReason =
    factory?.allowLocalRuntime === false
      ? RUNTIME_COPY.localDisabled
      : templateBypass
        ? AGENT_RUNTIME_COPY.bypassTemplate
        : undefined;
  const help = [
    AGENT_RUNTIME_COPY.note,
    templateRuntime && templateRuntime !== current
      ? AGENT_RUNTIME_COPY.templateDiffers(LABEL[templateRuntime as Runtime] ?? templateRuntime)
      : undefined,
    current === "docker" ? localReason : undefined,
  ]
    .filter(Boolean)
    .join(". ");

  async function switchTo(to: Runtime) {
    await updateAgent(agent.ref, { runtime: to });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["agent", agent.ref] }),
      qc.invalidateQueries({ queryKey: ["agent-config", agent.ref] }),
      qc.invalidateQueries({ queryKey: ["agents"] }),
    ]);
  }

  function choose(to: Runtime) {
    if (to === current) return;
    setError(undefined);
    if (to === "local") return setAsking(true);
    switchTo(to).catch((err: unknown) =>
      setError(err instanceof ApiError ? err.message : AGENT_RUNTIME_COPY.failed),
    );
  }

  return (
    <Section title="Runtime">
      <FieldShell name="runtime" label="Runtime" plainLabel help={help} error={error}>
        {({ id, describedBy }) => (
          <SegmentedControl
            legend="Runtime"
            name={name}
            value={current}
            describedBy={describedBy}
            options={(["docker", "local"] as const).map((value) =>
              value === "local" && localReason && current !== "local"
                ? { value, label: LABEL[value], unavailable: true, describedBy: `${id}-help` }
                : { value, label: LABEL[value] },
            )}
            onChange={choose}
          />
        )}
      </FieldShell>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={AGENT_RUNTIME_COPY.toLocalTitle(agent.handle)}
        body={AGENT_RUNTIME_COPY.toLocalBody}
        confirmLabel={AGENT_RUNTIME_COPY.toLocalAction(agent.handle)}
        pendingLabel="Switching…"
        onConfirm={() => switchTo("local")}
      />
    </Section>
  );
}
