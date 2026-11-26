import type { TagRange } from "./tag-ranges";

/** One state of a tag field: what undo goes back to. */
export type Snapshot = {
  text: string;
  ranges: readonly TagRange[];
  selection: readonly [number, number];
};

/** A pause this long between keystrokes starts a new undo step. */
export const PAUSE_MS = 500;
const MAX_STEPS = 200;
const isSpace = (s: string) => /\s/.test(s);

/**
 * The undo history of a tag field. Typing coalesces into one step per word (a space after a word
 * starts the next step) and per pause; `step` records a change that is always its own (a pick, a
 * whole-tag delete, a paste). Each call gets the state *before* the change.
 */
export class UndoStack {
  #past: Snapshot[] = [];
  #future: Snapshot[] = [];
  #typing = false;
  #lastAt = 0;
  #lastSpace = false;

  /** A change that is a step of its own. */
  step(before: Snapshot): void {
    this.#record(before);
    this.#typing = false;
  }

  /** A keystroke's change; `inserted` is the text it typed ("" for a deletion). */
  type(before: Snapshot, inserted: string): void {
    const at = Date.now();
    const space = isSpace(inserted);
    const continues = this.#typing && at - this.#lastAt <= PAUSE_MS && !(space && !this.#lastSpace);
    if (!continues) this.#record(before);
    this.#typing = true;
    this.#lastAt = at;
    this.#lastSpace = space;
  }

  /** The state to go back to, given the current one; undefined with nothing to undo. */
  undo(current: Snapshot): Snapshot | undefined {
    const s = this.#past.pop();
    if (!s) return undefined;
    this.#future.push(current);
    this.#typing = false;
    return s;
  }

  redo(current: Snapshot): Snapshot | undefined {
    const s = this.#future.pop();
    if (!s) return undefined;
    this.#past.push(current);
    this.#typing = false;
    return s;
  }

  clear(): void {
    this.#past = [];
    this.#future = [];
    this.#typing = false;
  }

  #record(before: Snapshot): void {
    this.#past.push(before);
    if (this.#past.length > MAX_STEPS) this.#past.shift();
    this.#future = [];
  }
}
