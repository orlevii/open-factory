import type { SlotPort } from "../../supervisor/slots.ts";

/** Always "granted": a SlotPort for runtime tests that don't exercise the Supervisor's cap. */
export const unlimitedSlots: SlotPort = {
  requestWake: () => "granted",
  release: () => {},
  becameHibernatable: () => {},
  stopFailed: () => {},
  closing: () => false,
  isQueued: () => false,
  isPulling: () => false,
  pause: () => {},
  pauseOf: () => undefined,
};
