import { fireEvent } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { installFileDropGuard } from "./file-drop";

let uninstall: (() => void) | undefined;
afterEach(() => uninstall?.());

const files = { files: [new File(["x"], "a.txt")], types: ["Files"] };

test("a file dragged or dropped outside a drop target never navigates the page", () => {
  uninstall = installFileDropGuard();
  const over = { ...files, dropEffect: "copy" };
  expect(fireEvent.dragOver(document.body, { dataTransfer: over })).toBe(false);
  expect(over.dropEffect).toBe("none");
  expect(fireEvent.drop(document.body, { dataTransfer: files })).toBe(false);
});

test("text drags are left alone, and a drop target's own handling stays", () => {
  uninstall = installFileDropGuard();
  expect(fireEvent.drop(document.body, { dataTransfer: { types: ["text/plain"] } })).toBe(true);
  const target = document.createElement("div");
  document.body.append(target);
  target.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  const over = { ...files, dropEffect: "copy" };
  fireEvent.dragOver(target, { dataTransfer: over });
  expect(over.dropEffect).toBe("copy");
  target.remove();
});
