import { KeyedMutex } from "../workspace/lock.ts";

/**
 * The Library lock (spec §9.6). Lock order is workspace (per ref), then Library, then store. Code that
 * holds it never takes a workspace lock and never awaits a runtime job; `ConfigChanges.libraryChanged`
 * runs only after it is released. Registered sources use the one key below.
 */
export const libraryLock = new KeyedMutex();

export const LIBRARY_KEY = "library";
