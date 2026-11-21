import type { AgentStatus } from "@open-factory/shared";
import { fireEvent, render } from "@testing-library/react";
import { expect, test } from "vitest";
import { AgentAvatar } from "./agent-avatar";

test("draws the generated face, aria-hidden", () => {
  const { container } = render(<AgentAvatar slug="lead" size={20} />);
  expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  expect(container.querySelector("svg")).not.toBeNull();
});

test("template override lies over the face and hides on error; a new version retries", () => {
  const { container, rerender } = render(
    <AgentAvatar slug="a" template="dev" avatarVersion="1-6" size={20} />,
  );
  const img = container.querySelector("img");
  if (!img) throw new Error("no override img");
  expect(img.getAttribute("src")).toBe("/api/templates/dev/avatar.svg?v=1-6");
  expect(img).toHaveAttribute("decoding", "async");
  fireEvent.error(img);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
  rerender(<AgentAvatar slug="a" template="dev" avatarVersion="2-6" size={20} />);
  expect(container.querySelector("img")).not.toBeNull();
});

test.each([
  ["working", "working"],
  ["errored", "errored"],
  ["rate_limited", "rate_limited"],
  ["queued", "queued"],
])("badge shape for %s", (s) => {
  const { container } = render(<AgentAvatar slug="a" size={20} status={s as AgentStatus} />);
  expect(container.querySelector(`[data-status-mark="${s}"]`)).not.toBeNull();
});

test.each(["idle", "hibernated", "terminated"])("no badge at rest: %s", (s) => {
  const { container } = render(<AgentAvatar slug="a" size={20} status={s as AgentStatus} />);
  expect(container.querySelector("[data-status-mark]")).toBeNull();
});

test.each(["idle", "hibernated", "terminated"])("no badge hole at rest: %s", (s) => {
  const { container } = render(<AgentAvatar slug="a" size={20} status={s as AgentStatus} />);
  expect(container.querySelector(".of-avatar-cut")).toBeNull();
});

test.each(["working", "errored", "rate_limited", "queued"])("badge hole for %s", (s) => {
  const { container } = render(<AgentAvatar slug="a" size={20} status={s as AgentStatus} />);
  expect(container.querySelector(".of-avatar-cut")).not.toBeNull();
});

test("no badge hole without a status", () => {
  const { container } = render(<AgentAvatar slug="a" size={20} />);
  expect(container.querySelector(".of-avatar-cut")).toBeNull();
});
