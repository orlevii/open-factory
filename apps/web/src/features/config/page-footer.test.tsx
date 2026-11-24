import { render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { NO_OUTCOME } from "@/components/forms/form-outcome";
import { PageFooter } from "./page-footer";

afterEach(() => vi.unstubAllGlobals());

const footer = (
  <PageFooter
    outcome={NO_OUTCOME}
    sticky
    pending={false}
    canSave
    canDiscard
    onSave={() => {}}
    onDiscard={() => {}}
  />
);

test("the page footer reports its height as the page's bottom scroll padding, and takes it back on unmount", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(72);
  const { unmount } = render(footer);
  expect(document.documentElement.style.getPropertyValue("--page-footer-height")).toBe("72px");
  unmount();
  expect(document.documentElement.style.getPropertyValue("--page-footer-height")).toBe("");
});
