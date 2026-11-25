import type { ConfigDoc } from "@open-factory/shared";
import { EffortField } from "@/features/config/effort-field";
import { ModelField } from "@/features/config/model-field";
import { ConfigFormScope } from "@/features/config/scope";

const NO_ISSUES: never[] = [];

/**
 * Model and Effort of New agent and Edit agent, side by side from `sm`. They are the Configuration page's own fields
 * over a small scope: the draft is this agent's overlay (what it overrides), the template's doc is the inherited layer.
 * Without a template they are off and say so.
 */
export function ModelEffortFields({
  value,
  base,
  onChange,
  disabledReason,
}: {
  value: unknown;
  base: ConfigDoc | null;
  onChange(next: (prev: unknown) => unknown): void;
  disabledReason?: string | undefined;
}) {
  return (
    <ConfigFormScope
      mode="agent"
      value={value}
      base={base}
      onChange={onChange}
      issues={NO_ISSUES}
      className="grid min-w-0 items-start gap-x-3 gap-y-4 sm:grid-cols-2"
      {...(disabledReason ? { disabledReason } : {})}
    >
      <ModelField />
      <EffortField />
    </ConfigFormScope>
  );
}
