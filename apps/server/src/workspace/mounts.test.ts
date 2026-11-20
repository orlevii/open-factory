import { expect, test } from "vitest";
import { buildMounts } from "./mounts.ts";

test("path parity; directory marketplaces read-only; others ignored", () => {
  expect(
    buildMounts({
      workdir: "/w",
      grantedPaths: ["/code/app"],
      hostSkillPaths: ["/real/skills/grilling"],
      tplSettings: {
        extraKnownMarketplaces: {
          a: { source: { source: "directory", path: "/mk" } },
          b: { source: { source: "github", repo: "o/r" } },
        },
      },
    }),
  ).toEqual([
    { source: "/w", target: "/w", readOnly: false },
    { source: "/code/app", target: "/code/app", readOnly: false },
    { source: "/real/skills/grilling", target: "/real/skills/grilling", readOnly: true },
    { source: "/mk", target: "/mk", readOnly: true },
  ]);
});
