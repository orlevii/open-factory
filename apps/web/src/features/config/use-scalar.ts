import { useCallback } from "react";
import { type ConfigField, FIELD_PATHS } from "./fields";
import { useConfigScope } from "./scope";
import { readAt } from "./tolerant";

/** The inherit item of a scalar Select: Radix forbids "" as an item value. */
export const INHERIT = "__inherit";

/**
 * A scalar field's reads and writes (spec §12.3): the draft's raw value, the template's inherited one (agent mode),
 * whether this agent overrides it, and a stable setter. `undefined` removes the key, which means inherit.
 */
export function useScalar(field: ConfigField) {
  const s = useConfigScope();
  const path = FIELD_PATHS[field];
  const own = readAt(s.value, path);
  const inherited = s.base ? readAt(s.base, path) : null;
  const { update } = s;
  const set = useCallback((v: unknown) => update(path, () => v), [update, path]);
  return {
    scope: s,
    path,
    own,
    /** The template's value, or undefined (agent mode without a base, or template mode: nothing inherited). */
    inherited: inherited?.ok ? inherited.value : undefined,
    /** Agent mode with a base: the help line names the inherited value. */
    inherits: s.mode === "agent" && s.base !== null,
    overridden: s.mode === "agent" && own.ok && own.value !== undefined,
    set,
  };
}
