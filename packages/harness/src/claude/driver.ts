import type { TransportFactory } from "../transport/types.ts";
import type { HarnessDriver } from "../types.ts";
import { buildClaudeArgs } from "./args.ts";
import { ClaudeProcess, type DriverLog } from "./process.ts";

export function createClaudeDriver(o: {
  log?: DriverLog;
  transports: { local: TransportFactory; docker?: TransportFactory };
}): HarnessDriver {
  return {
    start(spec, opts) {
      const factory = o.transports[spec.runtime];
      if (!factory) throw new Error(`No ${spec.runtime} transport configured`);
      return new ClaudeProcess(spec, opts, factory(spec, buildClaudeArgs(spec, opts)), o.log);
    },
  };
}
