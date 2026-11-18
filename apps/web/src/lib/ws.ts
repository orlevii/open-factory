import { type ClientMessage, type ServerMessage, serverMessageSchema } from "@open-factory/shared";

export type WsStatus = "connecting" | "open" | "closed";

export interface WsOptions {
  onUnauthenticated(): void;
  hasSession(): Promise<boolean>;
  onMessage?(m: ServerMessage): void;
  /** Called on every (re)open. */
  onOpen?(): void;
  /** Called on every status transition (and once with the initial "connecting"). */
  onStatus?(s: WsStatus): void;
  url?: string;
  WebSocketImpl?: typeof WebSocket;
}

export interface WsConnection {
  close(): void;
  status(): WsStatus;
  /** Writes JSON while open; returns false (and drops the frame) otherwise. */
  send(m: ClientMessage): boolean;
}

const MAX_DELAY_MS = 30_000;

/** One reconnecting socket per tab. A rejected upgrade (401) is indistinguishable from "server down"
 *  in browsers (close 1006), so every close re-checks the session. */
export function connectWs(opts: WsOptions): WsConnection {
  const Impl = opts.WebSocketImpl ?? WebSocket;
  const url =
    opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`;
  let attempt = 0;
  let stopped = false;
  let state: WsStatus | undefined;
  let ws: WebSocket | undefined;
  let isOpen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const setState = (next: WsStatus) => {
    if (next === state) return;
    state = next;
    opts.onStatus?.(next);
  };

  const open = () => {
    setState("connecting");
    const socket = new Impl(url);
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
      isOpen = true;
      setState("open");
      opts.onOpen?.();
    };
    socket.onmessage = (e) => {
      let data: unknown;
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return; // ignore non-JSON frames
      }
      const parsed = serverMessageSchema.safeParse(data);
      if (parsed.success) opts.onMessage?.(parsed.data);
    };
    socket.onclose = async () => {
      isOpen = false;
      if (stopped) return;
      setState("closed");
      const authed = await opts.hasSession().catch(() => true); // network error: keep retrying
      if (stopped) return;
      if (!authed) {
        stopped = true;
        opts.onUnauthenticated();
        return;
      }
      const delay = Math.min(MAX_DELAY_MS, 500 * 2 ** attempt++) * (0.5 + Math.random() / 2);
      timer = setTimeout(open, delay);
    };
  };
  open();
  return {
    close() {
      stopped = true;
      isOpen = false;
      clearTimeout(timer);
      setState("closed");
      ws?.close();
    },
    status: () => state ?? "connecting",
    send(m: ClientMessage) {
      if (!ws || !isOpen) return false;
      ws.send(JSON.stringify(m));
      return true;
    },
  };
}
