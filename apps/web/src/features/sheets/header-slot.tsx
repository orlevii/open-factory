import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/** The host's header, before its Close button: a body puts its header action here. */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

export function SheetHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlotContext);
  return slot ? createPortal(children, slot) : null;
}
