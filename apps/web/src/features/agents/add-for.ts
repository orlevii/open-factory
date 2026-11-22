import type { FocusEvent } from "react";

/**
 * A field's own add button (Add credential) carries `data-add-for="<field>"`. Leaving the field for it isn't leaving it
 * unchosen: the stacked child's result fills the field, so that blur doesn't validate.
 */
export const leavesForOwnAdd = (e: FocusEvent, field: string) =>
  e.relatedTarget instanceof HTMLElement &&
  e.relatedTarget.closest(`[data-add-for="${field}"]`) !== null;
