import { expect, test } from "vitest";
import { FakeDockerClient } from "../runtime/docker/testing/fake-docker.ts";
import { bridgeInfo, inCidr, resolveAgentBindHosts } from "./bind-hosts.ts";

const ifaces = (addr?: string) =>
  ({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    ...(addr ? { docker0: [{ address: addr, family: "IPv4", internal: false }] } : {}),
  }) as never;
const warn: string[] = [];
const base = { localAllowed: true, warn: (m: string) => warn.push(m) };

test("Linux binds the bridge gateway when it is on a host interface", () => {
  expect(
    resolveAgentBindHosts({
      ...base,
      platform: "linux",
      bridge: { gateway: "172.17.0.1", subnet: "172.17.0.0/16" },
      interfaces: ifaces("172.17.0.1"),
    }),
  ).toEqual({
    hosts: ["127.0.0.1", "172.17.0.1"],
    allowedSources: ["127.0.0.0/8", "::1/128", "172.17.0.0/16"],
  });
});
test("a gateway not on a host interface, or public, warns once and stays on loopback", () => {
  warn.length = 0;
  expect(
    resolveAgentBindHosts({
      ...base,
      platform: "linux",
      bridge: { gateway: "172.17.0.1", subnet: "172.17.0.0/16" },
      interfaces: ifaces(),
    }).hosts,
  ).toEqual(["127.0.0.1"]);
  expect(
    resolveAgentBindHosts({
      ...base,
      platform: "linux",
      bridge: { gateway: "8.8.8.1" },
      interfaces: ifaces("8.8.8.1"),
    }).hosts,
  ).toEqual(["127.0.0.1"]);
  expect(warn).toHaveLength(2);
  expect(warn[0]).toContain("set FACTORY_AGENT_HOST");
});
test("macOS uses loopback only; never 0.0.0.0 by default", () => {
  expect(
    resolveAgentBindHosts({
      ...base,
      platform: "darwin",
      bridge: { gateway: "172.17.0.1" },
      interfaces: ifaces("172.17.0.1"),
    }).hosts,
  ).toEqual(["127.0.0.1"]);
});
test("the default list never contains 0.0.0.0 or ::", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    for (const bridge of [
      {},
      { gateway: "172.17.0.1", subnet: "172.17.0.0/16" },
      { gateway: "0.0.0.0" },
    ]) {
      const { hosts } = resolveAgentBindHosts({
        ...base,
        platform,
        bridge,
        interfaces: ifaces("172.17.0.1"),
      });
      expect(hosts).not.toContain("0.0.0.0");
      expect(hosts).not.toContain("::");
    }
  }
});
test("an override address allows its interface's network, not a /32", () => {
  const nets = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false, cidr: "172.17.0.1/16" }],
  } as never;
  expect(
    resolveAgentBindHosts({
      ...base,
      platform: "linux",
      override: ["127.0.0.1", "172.17.0.1"],
      interfaces: nets,
    }),
  ).toEqual({
    hosts: ["127.0.0.1", "172.17.0.1"],
    allowedSources: ["127.0.0.0/8", "::1/128", "172.17.0.0/16"],
  });
});
test("an explicit 0.0.0.0 override accepts any source and warns once", () => {
  warn.length = 0;
  const r = resolveAgentBindHosts({
    ...base,
    platform: "linux",
    override: ["0.0.0.0"],
    interfaces: ifaces(),
  });
  expect(r).toEqual({ hosts: ["0.0.0.0"], allowedSources: ["0.0.0.0/0", "::/0"] });
  expect(warn).toEqual([
    "agent listener is reachable on all interfaces; the token is the only protection",
  ]);
});
test("the override replaces the list; local runtime needs a loopback in it", () => {
  expect(
    resolveAgentBindHosts({
      ...base,
      platform: "linux",
      override: ["127.0.0.1", "10.0.0.5"],
      interfaces: ifaces(),
    }).hosts,
  ).toEqual(["127.0.0.1", "10.0.0.5"]);
  expect(() =>
    resolveAgentBindHosts({
      ...base,
      platform: "linux",
      override: ["10.0.0.5"],
      interfaces: ifaces(),
    }),
  ).toThrow(/loopback/);
  expect(
    resolveAgentBindHosts({
      ...base,
      localAllowed: false,
      platform: "linux",
      override: ["10.0.0.5"],
      interfaces: ifaces(),
    }).hosts,
  ).toEqual(["10.0.0.5"]);
});
test("bridgeInfo returns the bridge, or {} when Docker fails", async () => {
  const d = new FakeDockerClient();
  d.bridge = { gateway: "172.17.0.1", subnet: "172.17.0.0/16" };
  expect(await bridgeInfo(d)).toEqual(d.bridge);
  d.bridgeNetwork = async () => {
    throw new Error("no docker");
  };
  expect(await bridgeInfo(d)).toEqual({});
});
test("a wildcard next to another address, or a duplicate, is a config error", () => {
  for (const override of [
    ["127.0.0.1", "0.0.0.0"],
    ["127.0.0.1", "::"],
    ["0.0.0.0", "::"],
    ["127.0.0.1", "127.0.0.1"],
  ]) {
    expect(() =>
      resolveAgentBindHosts({ ...base, platform: "linux", override, interfaces: ifaces() }),
    ).toThrow(/FACTORY_AGENT_HOST/);
  }
});
test("a non-loopback override address contributes its interface network", () => {
  const nets = {
    eth0: [{ address: "10.20.30.5", family: "IPv4", internal: false, cidr: "10.20.30.5/24" }],
  } as never;
  const { allowedSources } = resolveAgentBindHosts({
    ...base,
    platform: "linux",
    override: ["127.0.0.1", "10.20.30.5"],
    interfaces: nets,
  });
  expect(allowedSources).toContain("10.20.30.0/24");
  expect(allowedSources.some((c) => inCidr("10.20.30.99", c))).toBe(true);
  expect(allowedSources.some((c) => inCidr("10.20.31.1", c))).toBe(false);
});
test("inCidr handles IPv4-mapped addresses and rejects dotted-tail lookalikes", () => {
  expect(inCidr("::ffff:172.17.0.9", "172.17.0.0/16")).toBe(true);
  expect(inCidr("::ffff:172.18.0.9", "172.17.0.0/16")).toBe(false);
  expect(inCidr("::ffff:127.0.0.1", "127.0.0.0/8")).toBe(true);
  expect(inCidr("::1", "::1/128")).toBe(true);
  expect(inCidr("::1.0.0.0", "::1/128")).toBe(false);
  expect(inCidr("::1.0.0.0", "127.0.0.0/8")).toBe(false);
  expect(inCidr("10.1.2.3", "::/0")).toBe(false);
});
