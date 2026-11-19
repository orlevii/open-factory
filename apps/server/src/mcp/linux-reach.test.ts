import os from "node:os";
import Docker from "dockerode";
import { expect, test } from "vitest";
import { dockerodeClient } from "../runtime/docker/client.ts";
import { EXTRA_HOSTS, SECURITY_OPT } from "../runtime/docker/spec-hash.ts";
import { bridgeInfo, resolveAgentBindHosts } from "./bind-hosts.ts";
import { startAgentListener } from "./listener.ts";
import { AgentTokens } from "./tokens.ts";

// Spec §17.4: only the Linux CI job (`linux-reach`) sets this; Docker Desktop's networking differs.
const run = process.env.FACTORY_LINUX_REACH_TEST === "1" ? test : test.skip;
// busybox:1.37, the linux multi-arch index digest, pinned (verified with `docker buildx imagetools inspect busybox:1.37`).
const IMAGE = "busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";

const log = {
  fatal() {},
  trace() {},
  silent() {},
  level: "info",
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return log;
  },
} as never;

/** Drops the 8-byte multiplexing header Docker puts on every log frame. */
function demux(buf: Buffer): string {
  const parts: Buffer[] = [];
  for (let i = 0; i + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Creates, starts and waits for a container with these `HostConfig` options, returns its output, removes it. */
async function runIn(
  docker: Docker,
  image: string,
  cmd: string[],
  hostConfig: Docker.ContainerCreateOptions["HostConfig"],
): Promise<string> {
  const container = await docker.createContainer({
    Image: image,
    Cmd: cmd,
    HostConfig: hostConfig,
  });
  try {
    await container.start();
    await container.wait();
    return demux(await container.logs({ stdout: true, stderr: true }));
  } finally {
    await container.remove({ force: true });
  }
}

run(
  "a default-bridge container reaches the agent listener at host.docker.internal; other host addresses don't",
  async () => {
    const docker = new Docker();
    const client = dockerodeClient();
    await client.pull(IMAGE, new AbortController().signal);
    const bridge = await bridgeInfo(client);
    const { hosts, allowedSources } = resolveAgentBindHosts({
      platform: "linux",
      bridge,
      interfaces: os.networkInterfaces(),
      localAllowed: true,
      warn: console.warn,
    });
    expect(hosts).toContain(bridge.gateway);
    const l = await startAgentListener({
      hosts,
      port: 0,
      allowedSources,
      version: "ci",
      tokens: new AgentTokens(),
      isEnded: async () => false,
      mcp: async () => new Response("{}"),
      log,
    });
    try {
      // Mirrors ContainerManager's network options (the same constants spec-hash.ts builds its create options from);
      // no NetworkMode, so the default bridge.
      const out = await runIn(
        docker,
        IMAGE,
        [
          "sh",
          "-c",
          `wget -qO- http://host.docker.internal:${l.port}/api/status; echo; wget -S -O- --post-data='{}' http://host.docker.internal:${l.port}/mcp 2>&1 | grep 'HTTP/'`,
        ],
        { ExtraHosts: [...EXTRA_HOSTS], SecurityOpt: [...SECURITY_OPT] },
      );
      expect(out).toContain('{"version":"ci"}');
      expect(out).toContain("401");
      const primary = Object.values(os.networkInterfaces())
        .flat()
        .find(
          (i) => i && i.family === "IPv4" && !i.internal && i.address !== bridge.gateway,
        )?.address;
      expect(primary, "the runner has a primary non-loopback IPv4 address").toBeDefined();
      await expect(fetch(`http://${primary}:${l.port}/api/status`)).rejects.toThrow();
    } finally {
      await l.close();
    }
  },
  120_000,
);
