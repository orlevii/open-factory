import { createContext, useContext } from "react";

/** Provided by the signed-in layout. `null` means "outside the shell" (auth pages, root-level errors). */
export interface ShellState {
  connectionLost: boolean;
}

export const ShellContext = createContext<ShellState | null>(null);

export const useShell = () => useContext(ShellContext);
