import type { SlotPort, WakeReason } from "../../supervisor/slots.ts";

export type SlotEvent = ["request", WakeReason] | ["release"] | ["hibernatable"];

/** A SlotPort that records every call and grants every wake. */
export class RecordingSlots implements SlotPort {
  readonly events: SlotEvent[] = [];
  requestWake(_agentId: string, reason: WakeReason): "granted" {
    this.events.push(["request", reason]);
    return "granted";
  }
  release() {
    this.events.push(["release"]);
  }
  becameHibernatable() {
    this.events.push(["hibernatable"]);
  }
  closing() {
    return false;
  }
  isQueued() {
    return false;
  }
}
