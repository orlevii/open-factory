import type { SlotPort } from "../../supervisor/slots.ts";

/** Always "granted": a SlotPort for runtime tests that don't exercise the Supervisor. */
export const unlimitedSlots: SlotPort = {
  requestWake: () => "granted",
  release: () => {},
  closing: () => false,
  isQueued: () => false,
  isPulling: () => false,
  pause: () => {},
  pauseOf: () => undefined,
};
