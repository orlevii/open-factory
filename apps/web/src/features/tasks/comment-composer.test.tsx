import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FILES_NOTE } from "@/components/composer/composer";
import { readDraft, taskDraftKey } from "@/lib/drafts";
import { refFor } from "@/test/refs";
import { CommentComposer, type CommentComposerHandle } from "./comment-composer";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
let posts: unknown[];
beforeEach(() => {
  localStorage.clear();
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { body: string };
      posts.push(body);
      return json(
        {
          comment: {
            type: "comment",
            id: "c1",
            author: { kind: "human", ref: refFor("alice"), handle: "alice" },
            body: body.body,
            at: "2026-11-22T00:00:00.000Z",
          },
          deliveredTo: [],
          mentionedHumans: [],
          notReached: [],
        },
        201,
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function setup(qc = new QueryClient()) {
  const ref = createRef<CommentComposerHandle>();
  render(
    <QueryClientProvider client={qc}>
      <CommentComposer ref={ref} taskKey="T-1" assignee="dev" />
    </QueryClientProvider>,
  );
  return { ref, box: () => screen.getByRole("combobox", { name: "Comment" }) };
}

test("reply puts the mention at the start once and focuses", async () => {
  const { ref, box } = setup();
  await userEvent.type(box(), "thanks");
  box().blur();
  act(() => ref.current?.reply("@dev"));
  act(() => ref.current?.reply("@dev"));
  expect(box()).toHaveValue("@dev thanks");
  await waitFor(() => expect(box()).toHaveFocus());
});

test("reply from Preview goes back to Write and focuses", async () => {
  const { ref, box } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  act(() => ref.current?.reply("@dev"));
  await waitFor(() => expect(box()).toHaveFocus());
  expect(box()).toHaveValue("@dev ");
});

test("prefill only into an empty box, without focus, and not kept as a draft", async () => {
  const { ref, box } = setup();
  act(() => ref.current?.prefill("@dev"));
  expect(box()).toHaveValue("@dev ");
  expect(box()).not.toHaveFocus();
  expect(readDraft(taskDraftKey("T-1"))).toBe("");
  act(() => ref.current?.prefill("@ada"));
  expect(box()).toHaveValue("@dev ");
});

test("Enter posts (U1 rule) once and Shift+Enter adds a line; Send is the labelled primary", async () => {
  const { box } = setup();
  await userEvent.type(box(), "looks{Shift>}{Enter}{/Shift}good");
  expect(box()).toHaveValue("looks\ngood");
  expect(posts).toEqual([]);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(posts).toEqual([{ body: "looks\ngood" }]));
  await waitFor(() => expect(box()).toHaveValue(""));
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

test("a pasted file says files go in an agent's session and attaches nothing", () => {
  const { box } = setup();
  const file = new File(["x"], "shot.png", { type: "image/png" });
  fireEvent.paste(box(), { clipboardData: { files: [file], getData: () => "", types: ["Files"] } });
  expect(screen.getByText(FILES_NOTE)).toBeInTheDocument();
  expect(box()).toHaveValue("");
  expect(screen.queryByRole("button", { name: /attach/i })).toBeNull();
});

test("the draft lives in localStorage under of-draft:v1:task:<key>", async () => {
  const { box } = setup();
  await userEvent.type(box(), "half a thought");
  box().blur();
  expect(JSON.parse(localStorage.getItem("of-draft:v1:task:T-1") ?? "{}")).toMatchObject({
    text: "half a thought",
  });
});

test("a picked mention shows as @handle and is posted as <@ref>; a typed @name that wasn't picked is posted as text", async () => {
  const qc = new QueryClient();
  const principal = (handle: string, kind: "agent" | "human", name: string, state = "live") => ({
    id: handle,
    ref: refFor(handle),
    kind,
    handle,
    name,
    state,
    avatar: kind === "agent" ? { template: "t", avatarVersion: null, color: null } : null,
  });
  const list = [
    principal("dev", "agent", "Dev"),
    principal("dana", "human", "Dana"),
    principal("or", "human", "Or"),
    principal("dax", "human", "Dax", "disabled"),
  ];
  qc.setQueryData(["principals"], {
    byRef: new Map(list.map((p) => [p.ref, p])),
    unknown: new Set(),
  });
  // Dev reports to the viewer, so it ranks first once @dana is used.
  qc.setQueryData(["session"], { user: { handle: "or", ref: refFor("or") } });
  qc.setQueryData(
    ["agents", "exclude"],
    [{ ref: refFor("dev"), handle: "dev", reportsTo: { ref: refFor("or"), handle: "or" } }],
  );
  const { box } = setup(qc);
  await userEvent.type(box(), "cc @da");
  expect(screen.getByRole("option", { name: /Dana/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Dax/ })).toBeNull();
  await userEvent.keyboard("{Tab}");
  expect(box()).toHaveValue("cc @dana ");
  await userEvent.type(box(), "and @");
  await userEvent.keyboard("{Enter}");
  expect(box()).toHaveValue("cc @dana and @dev ");
  expect(posts).toEqual([]);
  await userEvent.type(box(), "and @ghost");
  await userEvent.keyboard("{Escape}{Enter}");
  await waitFor(() =>
    expect(posts).toEqual([{ body: `cc <@${refFor("dana")}> and <@${refFor("dev")}> and @ghost` }]),
  );
});

test("Reply to a human comment mentions its author: the box shows @handle and the post carries <@ref>", async () => {
  const qc = new QueryClient();
  qc.setQueryData(["principals"], {
    byRef: new Map([
      [
        refFor("dana"),
        {
          id: "d",
          ref: refFor("dana"),
          kind: "human",
          handle: "dana",
          name: "Dana",
          state: "live",
          avatar: null,
        },
      ],
    ]),
    unknown: new Set(),
  });
  const { ref, box } = setup(qc);
  act(() => ref.current?.reply(`<@${refFor("dana")}>`));
  expect(box()).toHaveValue("@dana ");
  await userEvent.type(box(), "thanks{Enter}");
  await waitFor(() => expect(posts).toEqual([{ body: `<@${refFor("dana")}> thanks` }]));
});

test("while a comment posts a muted Posting… status shows; Send keeps its label", async () => {
  let release: () => void = () => {};
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise<Response>((res) => {
        release = () =>
          res(
            json(
              {
                comment: {
                  type: "comment",
                  id: "c2",
                  author: { kind: "human", ref: refFor("alice"), handle: "alice" },
                  body: "x",
                  at: "2026-11-22T00:00:00.000Z",
                },
                deliveredTo: [],
                mentionedHumans: [],
                notReached: [],
              },
              201,
            ),
          );
      }),
  );
  const { box } = setup();
  await userEvent.type(box(), "x{Enter}");
  expect(await screen.findByText("Posting…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  await act(async () => release());
  await waitFor(() => expect(screen.queryByText("Posting…")).toBeNull());
});
