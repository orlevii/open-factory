import type { AgentStatus } from "@open-factory/shared";

const LABEL: Record<AgentStatus, string> = {
  hibernated: "Hibernated",
  working: "Working",
  idle: "Idle",
  errored: "Errored",
};

/** Colour + label, never colour alone. `working` uses the tooth (DESIGN.md → The pitch). */
export function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem]">
      <span aria-hidden="true" className="inline-flex size-3 items-center justify-center">
        {status === "working" ? (
          <span className="of-tooth" />
        ) : (
          <span
            className="size-1.5 rounded-full"
            style={{ background: `var(--status-${status})` }}
          />
        )}
      </span>
      {LABEL[status]}
    </span>
  );
}
