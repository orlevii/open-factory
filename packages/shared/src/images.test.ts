import { expect, test } from "vitest";
import { isUserImageRef, userImageTag } from "./images.ts";

test("isUserImageRef accepts bare names only", () => {
  for (const ok of ["playwright", "my_img.v2"]) expect(isUserImageRef(ok)).toBe(true);
  for (const bad of ["ubuntu:22.04", "docker.io/library/ubuntu", "a/b", "..", "Upper"])
    expect(isUserImageRef(bad)).toBe(false);
  expect(userImageTag("pw")).toBe("open-factory-user/pw:latest");
});
