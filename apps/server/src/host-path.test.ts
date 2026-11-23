import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MSG } from "@open-factory/shared";
import { expect, test } from "vitest";
import { FIELD_MSG } from "./field-messages.ts";
import { expandHome, resolveHostFolder } from "./host-path.ts";

const home = mkdtempSync(path.join(tmpdir(), "of-home-"));
mkdirSync(path.join(home, "code", "web"), { recursive: true });
writeFileSync(path.join(home, "file.txt"), "x");

test.each([
  ["~", "/h"],
  ["~/x", "/h/x"],
  ["~x", "~x"],
  ["/a", "/a"],
  ["a", "a"],
  ["~/", "/h"],
])("expandHome(%j) → %j", (p, out) => expect(expandHome(p, "/h")).toBe(out));

test("~/… and ~ resolve to realpaths under the home", async () => {
  await expect(resolveHostFolder("hostPath", "~/code/web", home)).resolves.toBe(
    realpathSync(path.join(home, "code/web")),
  );
  await expect(resolveHostFolder("hostPath", " ~ ", home)).resolves.toBe(realpathSync(home));
});

test.each(["~other/x", "code/web"])("%j is a shape error on the given field", async (p) => {
  await expect(resolveHostFolder("source", p, home)).rejects.toMatchObject({
    extra: { fields: { source: MSG.hostPathStart } },
  });
});

test.each(["~/missing", "~/file.txt"])("%j is a missing-folder error", async (p) => {
  await expect(resolveHostFolder("hostPath", p, home)).rejects.toMatchObject({
    extra: { fields: { hostPath: FIELD_MSG.noFolder } },
  });
});
