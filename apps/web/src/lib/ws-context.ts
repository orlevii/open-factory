import type { ClientMessage, ServerMessage } from "@open-factory/shared";
import { createContext, useContext } from "react";
import type { WsStatus } from "./ws";

export interface WsHub {
  send(m: ClientMessage): boolean;
  listen(fn: (m: ServerMessage) => void): () => void;
  status: WsStatus;
  /** Increments on every (re)open; effects that subscribe depend on it to resubscribe. */
  openCount: number;
}

export const WsContext = createContext<WsHub | null>(null);

export function useWs(): WsHub {
  const hub = useContext(WsContext);
  if (!hub) throw new Error("useWs outside the signed-in layout");
  return hub;
}
