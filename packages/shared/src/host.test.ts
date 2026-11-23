import { expect, test } from "vitest";
import { hostInfoSchema, isHostPathShape } from "./host.ts";

test.each([
  ["/a", true],
  ["/", true],
  ["~", true],
  ["~/code/web", true],
  ["~other/x", false],
  ["code/web", false],
  ["./x", false],
  ["", false],
  ["C:\\x", false],
])("isHostPathShape(%j) is %s", (p, ok) => expect(isHostPathShape(p)).toBe(ok));

test("hostInfoSchema accepts any platform string", () => {
  expect(
    hostInfoSchema.parse({ platform: "freebsd", hostname: "h", home: "/home/x" }).platform,
  ).toBe("freebsd");
});
