import websocket from "@fastify/websocket";
import { clientMessageSchema, normaliseRef, type ServerMessage } from "@open-factory/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { trustedOrigins } from "../auth/origins.ts";
import { getUser } from "../auth/require-user.ts";

const unauthorized = (reply: FastifyReply) =>
  reply.code(401).send({ error: { code: "unauthorized", message: "Not signed in" } });

export const MAX_FRAME_BYTES = 64 * 1024;
/** Above this many missing events a subscriber gets `resync` instead of a replay (spec §10). */
export const REPLAY_LIMIT = 1000;

export async function wsRoutes(app: FastifyInstance) {
  // ws defaults to 100 MiB frames, each JSON.parsed whole; client messages are tiny.
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  const allowed = new Set(trustedOrigins(app.config));

  async function checkUpgrade(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) return unauthorized(reply);
    if (origin === undefined && !/^Bearer\s+\S+/i.test(request.headers.authorization ?? ""))
      return unauthorized(reply);
    const user = await getUser(request);
    if (!user) return unauthorized(reply);
    request.user = user;
  }

  app.get("/api/ws", { websocket: true, preValidation: checkUpgrade }, (socket, request) => {
    const userId = request.user?.id;
    if (!userId) return socket.close(1008, "unauthorized");
    // Bus listeners can fire after the socket closed.
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const unsubs = new Map<string, () => void>();
    /** U3 §11.3: per subscribed agent, the live snapshot once its replay is done (a `live_snapshot` answer). */
    const snapshots = new Map<string, () => ServerMessage | undefined>();
    // Bumped by every subscribe and unsubscribe: a subscribe that resumes after an await and finds a newer
    // generation was superseded (by a later subscribe or an unsubscribe) and must not register anything.
    const generations = new Map<string, number>();
    let closed = false;
    // agent_status, supervisor and the global `*_changed` frames (I2: `config_changed`) go to every socket.
    const offAll = app.bus.subscribeAll(send);
    const offUser = app.bus.subscribeUser(userId, send); // S8: a user's read changes go to their own sockets only
    // S10 §9.4: disabling the user closes this socket; close() moves readyState off OPEN, so `send` stops at once.
    const offClose = app.bus.onUserClose(userId, () => socket.close(1008, "user disabled"));
    // A disable that committed between the upgrade's getUser and the line above missed this socket.
    void app.userAdmin
      .isDisabled(userId)
      .then((disabled) => {
        if (disabled && socket.readyState === socket.OPEN) socket.close(1008, "user disabled");
      })
      .catch((err) => request.log.error({ err }, "disabled re-check failed"));
    socket.on("close", () => {
      closed = true;
      offAll();
      offUser();
      offClose();
      for (const u of unsubs.values()) u();
      unsubs.clear();
    });
    const nextGeneration = (agent: string) => {
      const g = (generations.get(agent) ?? 0) + 1;
      generations.set(agent, g);
      return g;
    };
    const stop = (agent: string) => {
      unsubs.get(agent)?.();
      unsubs.delete(agent);
      snapshots.delete(agent);
    };

    /**
     * Gap-free subscribe (spec §10): 1. register on the bus and buffer, 2. read the DB, 3. drain the buffer
     * skipping seqs already sent, 4. stream live. Events are published after commit in seq order, so every
     * event is either in the DB read or in the buffer.
     */
    async function subscribe(agent: string, afterSeq: number) {
      const gen = nextGeneration(agent);
      stop(agent); // the newer request supersedes the older one now, replay included
      const current = () => !closed && generations.get(agent) === gen;
      const failed = (err: unknown) => {
        send({ type: "error", code: "internal_error", message: `Could not subscribe to ${agent}` });
        throw err;
      };
      const rt = await app.runtimes
        .byRef(normaliseRef(agent) ?? "")
        .catch((err) => (current() ? failed(err) : undefined));
      if (!current()) return;
      if (!rt)
        return send({ type: "error", code: "agent_not_found", message: "No agent at this ref" });
      let live = false;
      let cancelled = false;
      let lastSent = afterSeq;
      const buffer: ServerMessage[] = [];
      const forward = (m: ServerMessage) => {
        if (cancelled) return;
        if (m.type === "session_event") {
          if (m.event.seq <= lastSent) return;
          lastSent = m.event.seq;
        }
        send(m);
      };
      // U3 §11.3: live frames that arrive during the replay are dropped; the snapshot sent after it supersedes them.
      const off = app.bus.subscribe(rt.agent.id, (m) => {
        if (live) forward(m);
        else if (m.type !== "live") buffer.push(m);
      });
      // A later subscribe or unsubscribe for this agent (or a close) stops this one, replay included.
      unsubs.set(agent, () => {
        cancelled = true;
        buffer.length = 0;
        off();
      });
      try {
        send(rt.statusFrame());
        send({ type: "queue", agent, items: rt.queueItems() });
        const last = await app.store.lastSeq(rt.agent.id);
        if (last - afterSeq > REPLAY_LIMIT) {
          if (cancelled) return;
          send({ type: "resync", agent });
          lastSent = last;
        } else {
          const rows = await app.store.after(rt.agent.id, afterSeq, REPLAY_LIMIT);
          for (const event of rows) forward({ type: "session_event", agent, event });
        }
        for (const m of buffer.splice(0)) forward(m);
        // After the replay and the drain, in the same tick: the text so far, then live patches (U3 §11.3).
        forward(rt.liveSnapshot());
        live = true;
        snapshots.set(agent, () => (cancelled ? undefined : rt.liveSnapshot()));
      } catch (err) {
        if (cancelled) return; // superseded or closed meanwhile: nobody is waiting for this one
        stop(agent);
        failed(err);
      }
    }

    socket.on("message", (raw) => {
      let parsed: ReturnType<typeof clientMessageSchema.safeParse>;
      try {
        parsed = clientMessageSchema.safeParse(JSON.parse(String(raw)));
      } catch {
        return send({ type: "error", code: "bad_message", message: "Message is not valid JSON" });
      }
      if (!parsed.success)
        return send({ type: "error", code: "bad_message", message: "Unknown message" });
      const m = parsed.data;
      if (m.type === "ping") send({ type: "pong" });
      else if (m.type === "subscribe")
        void subscribe(m.agent, m.afterSeq).catch((err) =>
          request.log.error({ err }, "subscribe failed"),
        );
      else if (m.type === "unsubscribe") {
        nextGeneration(m.agent);
        stop(m.agent);
      } else if (m.type === "live_snapshot") {
        // Only for an agent this socket is subscribed to and caught up on: the same reach as its live frames.
        const snapshot = snapshots.get(m.agent)?.();
        if (snapshot) send(snapshot);
      }
    });
    send({ type: "hello", userId });
  });
}
