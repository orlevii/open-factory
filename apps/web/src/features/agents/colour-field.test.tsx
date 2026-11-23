import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { COLOUR_MSG, ColourField, colourName } from "@/features/agents/colour-field";

function Harness({
  start = null,
  avatarVersion,
}: {
  start?: number | null;
  avatarVersion?: string;
}) {
  const [v, setV] = useState<number | null>(start);
  return (
    <TooltipProvider>
      <ColourField slug="lead" value={v} onChange={setV} avatarVersion={avatarVersion} />
    </TooltipProvider>
  );
}

test("thirteen radios, Auto first, one tab stop on the selected one", () => {
  render(<Harness start={4} />);
  const radios = screen.getAllByRole("radio");
  expect(radios.map((r) => r.getAttribute("aria-label")).slice(0, 3)).toEqual([
    "Auto",
    "Olive",
    "Moss",
  ]);
  expect(radios).toHaveLength(13);
  expect(radios.filter((r) => r.tabIndex === 0).map((r) => r.getAttribute("aria-label"))).toEqual([
    "Teal",
  ]);
  expect(screen.getByRole("radio", { name: "Teal" }).className).toContain(
    "ring-2 ring-foreground ring-offset-2",
  );
});

test("a hue's name shows as a tooltip on focus", async () => {
  vi.useRealTimers();
  render(<Harness />);
  await userEvent.tab();
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Auto");
});

test("colourName names Auto's seeded hue and a chosen one", () => {
  expect(colourName(4, "lead")).toBe("Teal");
  expect(colourName(null, "lead")).toMatch(/^Auto \(\w+\)$/);
});

test("an avatar version replaces the group with the line", () => {
  render(<Harness avatarVersion="v1" />);
  expect(screen.getByText(COLOUR_MSG.templateAvatar)).toBeInTheDocument();
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
});
