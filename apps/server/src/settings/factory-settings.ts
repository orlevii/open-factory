import { type Db, schema } from "@open-factory/db";
import { eq } from "drizzle-orm";

export type FactorySettingsValues = {
  maxRunningAgents: number;
  defaultWarmWindowMinutes: number;
  memberUpdateDebounceSeconds: number;
  loopGuardMessages: number;
  loopGuardWindowMinutes: number;
};
type Current = FactorySettingsValues & { updatedAt: Date | null; updatedBy: string | null };
type Listener = (prev: FactorySettingsValues, next: FactorySettingsValues) => void;
type Log = { error: (obj: object, msg: string) => void };

const ROW_ID = 1;
const values = (c: Current): FactorySettingsValues => ({
  maxRunningAgents: c.maxRunningAgents,
  defaultWarmWindowMinutes: c.defaultWarmWindowMinutes,
  memberUpdateDebounceSeconds: c.memberUpdateDebounceSeconds,
  loopGuardMessages: c.loopGuardMessages,
  loopGuardWindowMinutes: c.loopGuardWindowMinutes,
});
const fromRow = (r: Current): Current => ({
  ...values(r),
  updatedAt: r.updatedAt,
  updatedBy: r.updatedBy,
});

/**
 * S10 §8.1–8.2: the single `factory_settings` row, loaded at boot with an in-memory copy (one process, ADR 0013).
 * Consumers take the getters, never a value, so an update reaches them on their next read.
 */
export class FactorySettings {
  private listeners: Listener[] = [];

  private constructor(
    private readonly db: Db,
    private current: Current,
    private readonly log: Log,
  ) {}

  static async load(db: Db, log: Log = console): Promise<FactorySettings> {
    const [row] = await db
      .select()
      .from(schema.factorySettings)
      .where(eq(schema.factorySettings.id, ROW_ID));
    if (!row) throw new Error("factory_settings has no row; run the migrations");
    return new FactorySettings(db, fromRow(row), log);
  }

  get(): Current {
    return { ...this.current };
  }

  readonly maxRunningAgents = (): number => this.current.maxRunningAgents;
  readonly defaultWarmWindowMinutes = (): number => this.current.defaultWarmWindowMinutes;
  /** The setting is stored in seconds; every consumer reads milliseconds. */
  readonly memberUpdateDebounceMs = (): number => this.current.memberUpdateDebounceSeconds * 1000;

  /** Loop guard (I8 §6.1): the per-direction message count that trips a hold. */
  readonly loopGuardMessages = (): number => this.current.loopGuardMessages;
  /** Loop guard window; stored in minutes, read in milliseconds. */
  readonly loopGuardWindowMs = (): number => this.current.loopGuardWindowMinutes * 60_000;

  /**
   * Writes the row, then swaps the copy (from what the row now holds), then calls the listeners. A listener that
   * throws is logged and never fails the update: the row and the copy have already changed.
   */
  async update(patch: Partial<FactorySettingsValues>, userId: string): Promise<void> {
    const [row] = await this.db
      .update(schema.factorySettings)
      .set({ ...patch, updatedAt: new Date(), updatedBy: userId })
      .where(eq(schema.factorySettings.id, ROW_ID))
      .returning();
    if (!row) throw new Error("factory_settings has no row; run the migrations");
    const prev = values(this.current);
    this.current = fromRow(row);
    const next = values(this.current);
    for (const fn of this.listeners) {
      try {
        fn(prev, next);
      } catch (err) {
        this.log.error({ err }, "a factory settings listener failed");
      }
    }
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }
}
