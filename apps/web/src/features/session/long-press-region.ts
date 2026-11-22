import { createContext, use } from "react";

/** True inside a timeline row that has a menu: its chrome is then a long-press region (U4 §11.2). The
 *  same speaker and sender lines elsewhere (the composer's queue) have no menu, so they stay plain. */
export const InLongPressRow = createContext(false);

/** `data-longpress-region` for this chrome, when its row has a menu a long-press opens. */
export function useLongPressRegion(): { "data-longpress-region"?: "" } {
  return use(InLongPressRow) ? { "data-longpress-region": "" } : {};
}
