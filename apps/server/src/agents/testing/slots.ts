import type { CredentialPause, SlotPort, WakeReason } from "../../supervisor/slots.ts";

export type SlotEvent = ["request", WakeReason] | ["release"] | ["hibernatable"] | ["stop_failed"];

/** A SlotPort that records every call and grants every wake (unless `answer` says otherwise). */
export class RecordingSlots implements SlotPort {
  readonly events: SlotEvent[] = [];
  /** What every wake request answers (default: granted). */
  answer: "granted" | "queued" | "dropped" = "granted";
  requestWake(_agentId: string, reason: WakeReason): "granted" | "queued" | "dropped" {
    this.events.push(["request", reason]);
    return this.answer;
  }
  release() {
    this.events.push(["release"]);
  }
  becameHibernatable() {
    this.events.push(["hibernatable"]);
  }
  stopFailed() {
    this.events.push(["stop_failed"]);
  }
  closing() {
    return false;
  }
  isQueued() {
    return false;
  }
  isPulling() {
    return false;
  }
  pause() {}
  pauseOf(_agentId?: string): CredentialPause | undefined {
    return undefined;
  }
}
