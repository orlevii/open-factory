import { type AgentStatus, agentStatusSchema } from "@open-factory/shared";
import { fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { refFor } from "@/test/refs";
import { AgentAvatar } from "./agent-avatar";

test("draws the generated face, aria-hidden", () => {
  const { container } = render(<AgentAvatar color={null} agentRef={refFor("lead")} size={20} />);
  expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  expect(container.querySelector("svg")).not.toBeNull();
});

test("template override lies over the face and hides on error; a new version retries", () => {
  const { container, rerender } = render(
    <AgentAvatar
      color={null}
      agentRef={refFor("a")}
      template="dev"
      avatarVersion="1-6"
      size={20}
    />,
  );
  const img = container.querySelector("img");
  if (!img) throw new Error("no override img");
  expect(img.getAttribute("src")).toBe("/api/templates/dev/avatar.svg?v=1-6");
  expect(img).toHaveAttribute("decoding", "async");
  fireEvent.error(img);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
  rerender(
    <AgentAvatar
      color={null}
      agentRef={refFor("a")}
      template="dev"
      avatarVersion="2-6"
      size={20}
    />,
  );
  expect(container.querySelector("img")).not.toBeNull();
});

test.each([
  ["working", "working"],
  ["errored", "errored"],
  ["rate_limited", "rate_limited"],
  ["queued", "queued"],
])("badge shape for %s", (s) => {
  const { container } = render(
    <AgentAvatar color={null} agentRef={refFor("a")} size={20} status={s as AgentStatus} />,
  );
  expect(container.querySelector(`[data-status-mark="${s}"]`)).not.toBeNull();
});

test.each(["idle", "hibernated", "terminated"])("no badge at rest: %s", (s) => {
  const { container } = render(
    <AgentAvatar color={null} agentRef={refFor("a")} size={20} status={s as AgentStatus} />,
  );
  expect(container.querySelector("[data-status-mark]")).toBeNull();
});

test("no badge hole without a status", () => {
  const { container } = render(<AgentAvatar color={null} agentRef={refFor("a")} size={20} />);
  expect(container.querySelector(".of-avatar-cut")).toBeNull();
});

function px(v: string | null | undefined) {
  return Number.parseFloat(v ?? "");
}

function badgeGeometry(container: HTMLElement) {
  const mark = container.querySelector<HTMLElement | SVGElement>("[data-status-mark]");
  const cut = container.querySelector<HTMLElement>(".of-avatar-cut");
  if (!mark || !cut) throw new Error("no badge");
  const w = px(mark.style.width || mark.getAttribute("width"));
  const h = px(mark.style.height || mark.getAttribute("height"));
  return {
    w,
    h,
    box: px(cut.style.getPropertyValue("--mark")),
    hole: px(cut.style.getPropertyValue("--hole")),
  };
}

test.each([
  [16, "rate_limited", 4, 4],
  [20, "rate_limited", 6, 6],
  [24, "rate_limited", 6, 6],
  [16, "queued", 4, 4],
  [20, "queued", 6, 6],
  [16, "errored", 4, 4],
  [20, "errored", 6, 6],
  [24, "errored", 6, 6],
  [16, "working", 4, 8],
  [20, "working", 4, 8],
  [24, "working", 6, 12],
] as const)("size %i %s badge is %ix%i, its hole 2px larger", (size, status, w, h) => {
  const { container } = render(
    <AgentAvatar color={null} agentRef={refFor("a")} size={size} status={status} />,
  );
  const g = badgeGeometry(container);
  expect([g.w, g.h]).toEqual([w, h]);
  expect(g.box).toBe(Math.max(w, h));
  expect(g.hole).toBe(g.box + 2);
});

test.each(agentStatusSchema.options)("%s: a hole exactly when there is a badge", (s) => {
  // The hole and the mark are decided in two places; every status must agree.
  const { container } = render(
    <AgentAvatar color={null} agentRef={refFor("a")} size={20} status={s} />,
  );
  const mark = container.querySelector("[data-status-mark]") !== null;
  expect(container.querySelector(".of-avatar-cut") !== null).toBe(mark);
});

test("no face's parts share a React key (eyes, mouth and accessory are siblings)", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let i = 0; i < 200; i++)
      render(<AgentAvatar color={null} agentRef={`agent-${i}`} template="t" size={16} />);
    render(<AgentAvatar color={null} agentRef={refFor("dev-old")} template="t" size={16} />);
    expect(error.mock.calls.filter((c) => String(c[0]).includes("same key"))).toEqual([]);
  } finally {
    error.mockRestore();
  }
});

test("an explicit colour fills the face over the handle's seed; Auto keeps the seed", () => {
  const fillOf = (c: HTMLElement) => c.querySelector("svg g")?.getAttribute("fill");
  const auto = render(<AgentAvatar color={null} agentRef={refFor("lead")} size={20} />);
  const seeded = fillOf(auto.container);
  expect(seeded).toMatch(/^var\(--avatar-(?:[1-9]|1[0-2])\)$/);
  const picked = render(<AgentAvatar color={12} agentRef={refFor("lead")} size={20} />);
  expect(fillOf(picked.container)).toBe("var(--avatar-12)");
  const other = render(<AgentAvatar color={1} agentRef={refFor("lead")} size={20} />);
  expect(fillOf(other.container)).toBe("var(--avatar-1)");
});

test("a template avatar.svg still lies over the colour", () => {
  const { container } = render(
    <AgentAvatar color={5} agentRef={refFor("a")} template="dev" avatarVersion="1-6" size={20} />,
  );
  expect(container.querySelector("img")).not.toBeNull();
});
