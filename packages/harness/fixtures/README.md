# Stream-json fixture traces

Real `claude -p --input-format stream-json --output-format stream-json --verbose` stdout traces
(Claude Code 2.1.327, mostly `haiku`, `--permission-mode auto`), read by the harness tests through
`readFixture` in `src/test-fixtures.ts`. Each `<name>.jsonl` is stdout only (the stream does not echo
our input). They were scrubbed before committing: scratch paths became `/spike/…`, `$HOME` became
`/home/user`, thinking signatures became `<signature>`, account-level connectors were dropped from
`system/init`, and strings over 2000 characters were truncated.

`rate-limit-event-live-allowed.ndjson` is one redacted live `rate_limit_event` line.
`rate-limit-event-rejected` is synthetic (built from the documented shape), so replace it with a real
trace when one is captured. `u3/` holds the chat-era traces (partial messages, the `initialize` command
list, local slash commands); see its README.
