import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { UploadService } from "./service.ts";

/** How often the unsent-upload sweep runs; an orphan lives at most 24 hours plus this. */
export const UPLOAD_SWEEP_INTERVAL_MS = 3_600_000;

/**
 * U3 §13.5 (Q42): deletes uploads never attached to a sent message once they are 24 hours old, every hour plus once
 * at the end of boot. The spec names a pg-boss schedule; the factory has no pg-boss dependency (and U3 adds none), so
 * this is an in-process timer like the spawned-agent `Reaper`. The age comes from the row, so downtime counts and a
 * missed run is caught up by the next. One run at a time; a failure is logged and retried by the next run.
 */
export class UploadSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly d: {
      uploads: Pick<UploadService, "sweepUnsent">;
      log: RuntimeLog;
      now: () => Date;
      interval?: number;
    },
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.run(), this.d.interval ?? UPLOAD_SWEEP_INTERVAL_MS);
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

  /** One sweep; a run requested while one is in progress joins it. Never rejects. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running)
      this.running = this.d.uploads
        .sweepUnsent(this.d.now())
        .then((n) => {
          if (n) this.d.log.info({ count: n }, "deleted unsent uploads older than 24 hours");
        })
        .catch((err: unknown) => this.d.log.error({ err }, "the unsent-upload sweep failed"))
        .finally(() => {
          this.running = undefined;
        });
    return this.running;
  }
}
