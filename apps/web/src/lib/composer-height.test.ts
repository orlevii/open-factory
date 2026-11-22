import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { registerDockedComposer } from "./composer-height";

type Cb = (r: { contentRect: { height: number } }[]) => void;
const observers = new Map<Element, Cb>();
const read = () => document.documentElement.style.getPropertyValue("--composer-h");

class FakeRO {
  constructor(private cb: Cb) {}
  observe(el: Element) {
    observers.set(el, this.cb);
  }
  disconnect() {}
  unobserve() {}
}
const resize = (el: Element, height: number) => {
  observers.get(el)?.([{ contentRect: { height } }]);
  vi.advanceTimersToNextFrame();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("ResizeObserver", FakeRO);
  document.documentElement.style.removeProperty("--composer-h");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  observers.clear();
});

test("--composer-h is the maximum of the registered composers, 0 when none", () => {
  const a = document.createElement("div");
  const b = document.createElement("div");
  const offA = registerDockedComposer("a", a);
  const offB = registerDockedComposer("b", b);
  resize(a, 80);
  resize(b, 120);
  expect(read()).toBe("120px");
  offB();
  vi.advanceTimersToNextFrame();
  expect(read()).toBe("80px");
  offA();
  vi.advanceTimersToNextFrame();
  expect(read()).toBe("0px");
});

test("a resize that keeps the maximum writes nothing", () => {
  const a = document.createElement("div");
  const b = document.createElement("div");
  const offA = registerDockedComposer("a", a);
  const offB = registerDockedComposer("b", b);
  resize(a, 80);
  resize(b, 120);
  const set = vi.spyOn(document.documentElement.style, "setProperty");
  resize(a, 90);
  expect(set).not.toHaveBeenCalled();
  offA();
  offB();
  vi.advanceTimersToNextFrame();
});
