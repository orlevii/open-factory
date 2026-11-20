# S8 follow-up issue drafts

The harness denied creating issues from the implementation session, so these are drafts for the lead. #60 (ended-assignee filter), #61 (task text search) and #62 (turns to tasks, S10) already exist.

## Note to add on #47 (loop guard)

S8 adds a second agent-to-agent path: `comment_task` mentions deliver a `task_comment` to any live agent, and `@humans` mentions fan out to every user's inbox. Neither has a count or rate cap (spec §15, §19). A loop guard should cover comments and task updates as well as `send_message`.

## Unpaged task activity

`GET /api/tasks/:key` returns the whole activity (comments and history). Fine for tens of comments; page it (like `get_task`'s `comments_before`) if a task page measures slow. Same shape as #22.

## Real-browser check of browser notifications

The notification switch, permission prompt and `Notification` click handling are covered by unit tests with a stubbed `Notification`, and the switch was exercised in headless Chrome only up to the permission prompt. A pass in a headed browser (granted, denied, revoked later, two tabs with the same `tag`) is still owed.

## `get_task` called without an id by haiku

In the live smoke a haiku agent's first `get_task` call arrived with `{}` (a validation error), then succeeded on retry after it read the schema. Consider a tool description that names the `id` argument first; not a defect in the server.

## Mark all read window

An inbox item stamped inside a transaction just before the client's `upTo` but committed after the client loaded the list is marked read unseen (spec §11.2, accepted). If it is ever observed in practice, mark by item id instead of by `upTo`.
