import { expect, test } from "vitest";
import { resolveImage } from "./resolve.ts";

const d = "ghcr.io/open-factory/base:latest";

test("a bare template image is a user image with its local tag", () => {
  expect(resolveImage("playwright", d)).toEqual({
    kind: "user",
    name: "playwright",
    tag: "open-factory-user/playwright:latest",
  });
});

test("no template image is the factory default, a registry ref even when it is a bare name", () => {
  expect(resolveImage(undefined, d)).toEqual({ kind: "registry", ref: d, tag: d });
  expect(resolveImage(undefined, "ubuntu")).toEqual({
    kind: "registry",
    ref: "ubuntu",
    tag: "ubuntu",
  });
});

test.each(["docker.io/library/ubuntu", "ubuntu:22.04", "org/image", "img@sha256:abc"])(
  "%s is a registry reference",
  (ref) => {
    expect(resolveImage(ref, d)).toEqual({ kind: "registry", ref, tag: ref });
  },
);
