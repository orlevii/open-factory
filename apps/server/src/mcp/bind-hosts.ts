import { isIP } from "node:net";
import type os from "node:os";
import type { DockerClient } from "../runtime/docker/client.ts";

const LOOPBACK_CIDRS = ["127.0.0.0/8", "::1/128"];
const ANY_CIDRS = ["0.0.0.0/0", "::/0"];
export const ALL_INTERFACES_WARNING =
  "agent listener is reachable on all interfaces; the token is the only protection";
export const BRIDGE_WARNING =
  "Docker agents can't reach the factory: set FACTORY_AGENT_HOST to the address host.docker.internal resolves to in your containers.";

/** An IP as a bit string source: IPv4 -> 32-bit bigint, IPv6 -> 128-bit; IPv4-mapped IPv6 is unwrapped. */
function parseIp(raw: string): { v: 4 | 6; n: bigint } | undefined {
  let ip = raw.split("%")[0] ?? raw;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) ip = mapped[1];
  const fam = isIP(ip);
  if (fam === 4) {
    return { v: 4, n: ip.split(".").reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n) };
  }
  if (fam === 6) {
    // A dotted tail (`::1.2.3.4`) is two hex groups; never read it as one group.
    const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
    if (dotted) {
      const [, pre = "", a = "0", b = "0", c = "0", d = "0"] = dotted;
      const hex = (x: string, y: string) => (Number(x) * 256 + Number(y)).toString(16);
      ip = `${pre}${hex(a, b)}:${hex(c, d)}`;
    }
    const [head = "", tail] = ip.split("::") as [string, string?];
    const groups = (x: string) => (x ? x.split(":") : []);
    const hs = groups(head);
    const ts = tail === undefined ? [] : groups(tail);
    const all =
      tail === undefined ? hs : [...hs, ...Array(8 - hs.length - ts.length).fill("0"), ...ts];
    return { v: 6, n: all.reduce((n, g) => (n << 16n) | BigInt(Number.parseInt(g, 16)), 0n) };
  }
  return undefined;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base = "", lenStr] = cidr.split("/");
  const a = parseIp(ip);
  const b = parseIp(base);
  if (!a || !b || a.v !== b.v) return false;
  const bits = a.v === 4 ? 32 : 128;
  const len = lenStr === undefined ? bits : Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > bits) return false;
  const shift = BigInt(bits - len);
  return a.n >> shift === b.n >> shift;
}

/** `172.17.0.1/16` -> `172.17.0.0/16`. */
export function networkOf(cidr: string): string | undefined {
  const [base = "", lenStr] = cidr.split("/");
  const p = parseIp(base);
  if (!p || lenStr === undefined) return undefined;
  const bits = p.v === 4 ? 32 : 128;
  const len = Number(lenStr);
  if (!Number.isInteger(len) || len < 0 || len > bits) return undefined;
  const shift = BigInt(bits - len);
  const n = (p.n >> shift) << shift;
  if (p.v === 4) {
    return `${[24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n)).join(".")}/${len}`;
  }
  const groups = Array.from({ length: 8 }, (_, i) =>
    Number((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16),
  );
  return `${groups.join(":")}/${len}`;
}

const isLoopback = (h: string) =>
  h === "localhost" || inCidr(h, "127.0.0.0/8") || inCidr(h, "::1/128");
const isWildcard = (h: string) => h === "0.0.0.0" || h === "::";
const isPrivateV4 = (h: string) =>
  inCidr(h, "10.0.0.0/8") || inCidr(h, "172.16.0.0/12") || inCidr(h, "192.168.0.0/16");

type Interfaces = ReturnType<typeof os.networkInterfaces>;

function findInterfaceEntry(interfaces: Interfaces, address: string) {
  for (const list of Object.values(interfaces)) {
    for (const e of list ?? []) if (e.address === address) return e;
  }
  return undefined;
}

export interface BindInput {
  platform: NodeJS.Platform;
  override?: string[];
  bridge?: { gateway?: string; subnet?: string };
  interfaces: Interfaces;
  localAllowed: boolean;
  warn(msg: string): void;
}

/**
 * The agent listener's bind list and the CIDRs its sources must fall in (spec §5.3).
 * The default list never contains `0.0.0.0` or `::`; only an explicit override can.
 */
export function resolveAgentBindHosts(i: BindInput): { hosts: string[]; allowedSources: string[] } {
  const allowed = [...LOOPBACK_CIDRS];
  const add = (c: string | undefined) => {
    if (c && !allowed.includes(c)) allowed.push(c);
  };

  if (i.override) {
    const hosts = [...i.override];
    // Linux can't bind a wildcard next to another address (or the same one twice): EADDRINUSE.
    if (new Set(hosts).size !== hosts.length) {
      throw new Error("FACTORY_AGENT_HOST lists the same address twice");
    }
    if (hosts.length > 1 && hosts.some(isWildcard)) {
      throw new Error(
        "FACTORY_AGENT_HOST: 0.0.0.0 or :: must be the only entry (it already covers every address)",
      );
    }
    // Local agents are handed http://127.0.0.1:<port>/mcp (start.ts): another loopback (::1, 127.0.0.2) isn't it.
    // A wildcard covers it (Node's `::` is dual-stack).
    if (i.localAllowed && !hosts.some((h) => h === "127.0.0.1" || isWildcard(h))) {
      throw new Error(
        "FACTORY_AGENT_HOST must contain 127.0.0.1 while the local runtime is allowed (local agents reach the factory there)",
      );
    }
    if (hosts.some(isWildcard)) {
      i.warn(ALL_INTERFACES_WARNING);
      return { hosts, allowedSources: [...ANY_CIDRS] };
    }
    for (const h of hosts) {
      if (isLoopback(h)) continue;
      // An address on no host interface contributes nothing; binding it fails the boot (§5.3).
      const entry = findInterfaceEntry(i.interfaces, h);
      if (entry?.cidr) add(networkOf(entry.cidr));
    }
    return { hosts, allowedSources: allowed };
  }

  const hosts = ["127.0.0.1"];
  if (i.platform === "linux") {
    const gw = i.bridge?.gateway;
    if (gw && isPrivateV4(gw) && findInterfaceEntry(i.interfaces, gw)) {
      hosts.push(gw);
      const entry = findInterfaceEntry(i.interfaces, gw);
      add(i.bridge?.subnet ?? (entry?.cidr ? networkOf(entry.cidr) : undefined));
    } else {
      i.warn(BRIDGE_WARNING);
    }
  }
  return { hosts, allowedSources: allowed };
}

/** The default bridge's gateway and subnet; `{}` when Docker isn't reachable. */
export async function bridgeInfo(
  docker: DockerClient,
): Promise<{ gateway?: string; subnet?: string }> {
  try {
    return await docker.bridgeNetwork();
  } catch {
    return {};
  }
}
