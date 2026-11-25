import { type Db, schema } from "@open-factory/db";
import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore } from "../agents/event-store.ts";

const { credentials } = schema;

/** How often the expiry check runs; the notice goes out at most this late. */
export const EXPIRY_CHECK_INTERVAL_MS = 3_600_000;
const WARN_BEFORE_MS = 14 * 24 * 3_600_000;

/** `YYYY-MM-DD` of an instant in a time zone. */
function formatDateInZone(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * I3 §5.7: tells every user in the Inbox when a credential expires within 14 days (or already has), once per
 * credential (a replace re-arms it). An in-process hourly timer, the `UploadSweep` shape; the conditional update on
 * `expiry_notified_at` makes a repeated run, a boot race or a second server unable to double the notice.
 */
export class ExpiryCheck {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly d: {
      db: Db;
      store: EventStore;
      bus: Pick<EventBus, "publishToUser">;
      zone: string;
      now: () => Date;
      log: RuntimeLog;
      interval?: number;
    },
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.run(), this.d.interval ?? EXPIRY_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async idle(): Promise<void> {
    await this.running;
  }

  /** One check; a run requested while one is in progress joins it. Never rejects. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running)
      this.running = this.check()
        .catch((err: unknown) => this.d.log.error({ err }, "the credential expiry check failed"))
        .finally(() => {
          this.running = undefined;
        });
    return this.running;
  }

  private async check(): Promise<void> {
    const { db, store, zone } = this.d;
    const at = this.d.now();
    const due = await db
      .select({ id: credentials.id, name: credentials.name, expiresAt: credentials.expiresAt })
      .from(credentials)
      .where(
        and(
          isNotNull(credentials.expiresAt),
          lte(credentials.expiresAt, new Date(at.getTime() + WARN_BEFORE_MS)),
          isNull(credentials.expiryNotifiedAt),
        ),
      );
    for (const c of due) {
      if (!c.expiresAt) continue;
      const expiresAt = c.expiresAt;
      const userIds = await db.transaction(async (tx) => {
        const [hit] = await tx
          .update(credentials)
          .set({ expiryNotifiedAt: at })
          .where(and(eq(credentials.id, c.id), isNull(credentials.expiryNotifiedAt)))
          .returning({ id: credentials.id });
        if (!hit) return [];
        const verb = expiresAt <= at ? "expired" : "expires";
        const out = await store.createHumanMessage(
          {
            kind: "system",
            notice: "credential_expiring",
            subjectCredentialId: c.id,
            to: "all",
            inboxKind: "credential",
            body: `${c.name} ${verb} on ${formatDateInZone(expiresAt, zone)}.`,
            urgent: false,
            createdAt: at,
          },
          tx,
        );
        return out.userIds;
      });
      for (const userId of userIds) this.d.bus.publishToUser(userId, { type: "inbox_changed" });
    }
  }
}
