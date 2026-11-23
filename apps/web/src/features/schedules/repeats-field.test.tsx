import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { pickOption } from "@/test/select-helpers";
import { RepeatsField } from "./repeats-field";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

function Harness({ start, onLeave = () => {} }: { start: string; onLeave?: () => void }) {
  const [cron, setCron] = useState(start);
  return (
    <>
      <RepeatsField
        cron={cron}
        onCron={setCron}
        zone="Europe/Berlin"
        error={undefined}
        onBlurCron={onLeave}
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
  expect(screen.queryByLabelText("Repeats cron pattern")).toBeNull();
  expect(screen.queryByText(/\(Europe\/Berlin\)/)).toBeNull();
});

test("Custom shows the input, the help and the summary with the zone", async () => {
  render(<Harness start="0 9 * * 1-5" />);
  await pickOption(trigger(), "Custom cron…");
  expect(screen.getByLabelText("Repeats cron pattern")).toHaveValue("0 9 * * 1-5");
  expect(screen.getByText("Cron help")).toBeInTheDocument();
  expect(screen.getByText(/A 5-field cron expression/)).toBeInTheDocument();
  expect(screen.getByText("Weekdays at 09:00 (Europe/Berlin)")).toBeInTheDocument();
});

test("a cron matching no preset opens on Custom with no summary", () => {
  render(<Harness start="*/7 * * * *" />);
  expect(trigger()).toHaveTextContent("Custom cron…");
  expect(screen.getByLabelText("Repeats cron pattern")).toHaveValue("*/7 * * * *");
  const line = screen.getByTestId("cron-summary");
  expect(line).toHaveTextContent("");
});

test("the preset list validates when it closes, after the pick has rendered, not when it opens", async () => {
  const seen: string[] = [];
  const leave = vi.fn(() => seen.push(screen.getByTestId("cron").textContent ?? ""));
  render(<Harness start="" onLeave={leave} />);
  await userEvent.click(trigger());
  expect(leave).not.toHaveBeenCalled();
  await userEvent.click(await screen.findByRole("option", { name: "Weekdays at 09:00" }));
  expect(leave).toHaveBeenCalledTimes(1);
  expect(seen).toEqual(["0 9 * * 1-5"]);
});

test("tabbing off the closed preset trigger is a leave; picking Custom is not", async () => {
  const leave = vi.fn();
  render(
    <>
      <Harness start="" onLeave={leave} />
      <button type="button">after</button>
    </>,
  );
  trigger().focus();
  await userEvent.tab();
  expect(leave).toHaveBeenCalledTimes(1);
  await pickOption(trigger(), "Custom cron…");
  expect(leave).toHaveBeenCalledTimes(1);
});
