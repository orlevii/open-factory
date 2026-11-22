import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  // Drafts (the session composer's in localStorage, the comment composer's in sessionStorage): no test
  // inherits another's. A test that left a throwing storage stubbed (private mode) must not fail here.
  try {
    sessionStorage.clear();
    for (const k of Object.keys(localStorage))
      if (k.startsWith("of-draft:")) localStorage.removeItem(k);
  } catch {
    /* stubbed to throw */
  }
});

// The first render in a file loads the whole route tree; on a slow CI runner that can pass the 1 s default.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no matchMedia; the shadcn sidebar's useIsMobile needs it.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom does not implement scrollTo; the router's scroll restoration calls it.
window.scrollTo = () => {};

// jsdom has no ResizeObserver; Radix Checkbox and Popover measure with it.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not implement scrollIntoView; the settings hash handling and the template editor call it.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has no pointer-capture API; Radix Select calls it on pointer events.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

// jsdom has no elementFromPoint; the timeline's scroll anchor probes with it. Nothing is hit by default.
if (!document.elementFromPoint) document.elementFromPoint = () => null;
