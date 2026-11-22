import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { pickOption } from "@/test/select-helpers";
import { RepeatsField } from "./repeats-field";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

function Harness({ start }: { start: string }) {
  const [cron, setCron] = useState(start);
  return (
    <>
      <RepeatsField
        cron={cron}
        onCron={setCron}
        zone="Europe/Berlin"
        error={undefined}
        onBlurCron={() => {}}
      />
      <output data-testid="cron">{cron}</output>
    </>
  );
}
const trigger = () => screen.getByRole("combobox", { name: "Repeats" });

test("a preset sets the cron and shows no input and no summary", async () => {
  render(<Harness start="" />);
  await pickOption(trigger(), "Weekdays at 09:00");
  expect(screen.getByTestId("cron")).toHaveTextContent("0 9 * * 1-5");
  expect(trigger()).toHaveTextContent("Weekdays at 09:00");
  expect(screen.queryByLabelText("Cron pattern")).toBeNull();
  expect(screen.queryByText(/\(Europe\/Berlin\)/)).toBeNull();
});

test("Custom shows the input, the help and the summary with the zone", async () => {
  render(<Harness start="0 9 * * 1-5" />);
  await pickOption(trigger(), "Custom cron…");
  expect(screen.getByLabelText("Cron pattern")).toHaveValue("0 9 * * 1-5");
  expect(screen.getByText("Cron help")).toBeInTheDocument();
  expect(screen.getByText(/A 5-field cron expression/)).toBeInTheDocument();
  expect(screen.getByText("Weekdays at 09:00 (Europe/Berlin)")).toBeInTheDocument();
});

test("a cron matching no preset opens on Custom with no summary but the reserved line", () => {
  render(<Harness start="*/7 * * * *" />);
  expect(trigger()).toHaveTextContent("Custom cron…");
  expect(screen.getByLabelText("Cron pattern")).toHaveValue("*/7 * * * *");
  const line = screen.getByTestId("cron-summary");
  expect(line).toHaveTextContent("");
  expect(line.className).toContain("min-h-[1.125rem]");
});
