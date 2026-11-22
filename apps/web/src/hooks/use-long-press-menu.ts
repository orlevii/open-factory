import { useCallback, useMemo, useState } from "react";
import { type PickPressed, useLongPress } from "./use-long-press";

type Point = { x: number; y: number };

/** A row's own menu, opened by its ⋯ or by a long-press on the row (U4 §11.2): spread `press` on the
 *  row and `menu` on its `AdaptiveMenu`. A long-press hangs the menu from the press point; an opening
 *  by the ⋯ drops the point. Both objects are stable while the menu's state is. */
export function useLongPressMenu({ pick }: { pick?: PickPressed } = {}) {
  const [state, setState] = useState<{ open: boolean; anchor?: Point }>({ open: false });
  const onLongPress = useCallback((anchor: Point) => setState({ open: true, anchor }), []);
  const press = useLongPress(onLongPress, { pick });
  const onOpenChange = useCallback(
    (open: boolean) => setState((s) => (open ? { open } : { ...s, open })),
    [],
  );
  const menu = useMemo(
    () => ({ open: state.open, onOpenChange, anchor: state.anchor }),
    [state, onOpenChange],
  );
  return { press, menu };
}

/** The pressed row itself, unless the press started in a field (a long-press there selects text). */
export const pickRowOutsideFields: PickPressed = (e) =>
  e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")
    ? null
    : e.currentTarget;
