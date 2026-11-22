import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { refreshList, withItem, writeToList } from "./add-to-list";

type Row = { name: string };
const KEY = ["things"];

function heldFetch(qc: QueryClient) {
  let answer: (rows: Row[]) => void = () => {};
  const done = qc
    .fetchQuery({
      queryKey: KEY,
      queryFn: () =>
        new Promise<Row[]>((r) => {
          answer = r;
        }),
    })
    .catch(() => {});
  return { answer: (rows: Row[]) => answer(rows), done };
}

test("a fetch pending when the item is added resolves without dropping it, even with no observer", async () => {
  const qc = new QueryClient();
  qc.setQueryData<Row[]>(KEY, [{ name: "a" }]);
  // No observer: refetchType "active" leaves this list alone, so only the cancel stops the stale answer.
  const pending = heldFetch(qc);
  await writeToList<Row[]>(qc, KEY, withItem({ name: "b" }));
  refreshList(qc, KEY);
  pending.answer([{ name: "a" }]);
  await pending.done;
  expect(qc.getQueryData<Row[]>(KEY)?.map((r) => r.name)).toEqual(["a", "b"]);
});

test("an unfetched list stays unfetched", async () => {
  const qc = new QueryClient();
  await writeToList<Row[]>(qc, KEY, withItem({ name: "b" }));
  expect(qc.getQueryData(KEY)).toBeUndefined();
});

test("withItem replaces a row with the same name", () => {
  expect(
    withItem({ name: "b", v: 2 })([
      { name: "b", v: 1 },
      { name: "c", v: 1 },
    ]),
  ).toEqual([
    { name: "c", v: 1 },
    { name: "b", v: 2 },
  ]);
});
