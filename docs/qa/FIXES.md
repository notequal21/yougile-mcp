# Independent QA fixes

The original independent QA reports remain unchanged. All seven expected-fail reproductions are now ordinary passing tests.

| Finding | Correction and regression |
|---|---|
| P1-1 / Haiku F1 | Sprint input uses seconds; ISO dates convert with floor; numeric seconds pass through. `test/qa/haiku/findings.test.ts`, `test/tools/stickers.tools.test.ts`. |
| P2-1 / Opus QA-1 | Pagination distinguishes deadline `TimeoutError` from caller cancellation and returns accumulated items with `truncated`. `test/qa/opus/regressions.test.ts`. |
| P2-2 / Codex | A known 429 remains `rate_limited` when retry wait exceeds the deadline. `test/qa/codex/http-review.test.ts`. |
| P2-3 / Opus QA-2 | Every 429 penalizes the shared limiter; Retry-After is honored up to 60 seconds (including excessive values). `test/qa/opus/regressions.test.ts`. |
| P2-4 / Haiku F2 | Webhook event accepts a valid JavaScript regexp, including alternation. `test/qa/haiku/findings.test.ts`; invalid regexp remains rejected in `test/tools/chats-webhooks.test.ts`. |
| P3-1 / Opus QA-3 | Successful empty responses resolve; non-JSON success raises a non-retryable protocol error. `test/qa/opus/regressions.test.ts`. |
| P3-2 / Haiku F3 | `YOUGILE_LOG_LEVEL` is explicitly reserved. Runtime stacks could reveal keys or URLs, so the architecture now prohibits emitting them. |
| P3-3 / Opus | Date strings require ISO date or timezone-explicit datetime; lenient strings are rejected. One shared validator is used by tasks, chats, and sprint stickers; local calendar dates are checked before offset conversion, and negative/fractional epochs are rejected. |
| Haiku F4–F6 | Spec contradictions and the unusual company path are recorded in `docs/ARCHITECTURE.md`; no live verification was authorized. |

## Final retest follow-up

- R1/M2: Offset datetimes that cross a UTC day remain valid, while invalid local calendar dates and negative/fractional epoch values fail through the shared `EpochMs` schema.
- R2: Any HTTP 429 pauses the shared company limiter for the smaller of `Retry-After` (or its default) and 60 seconds. A retry delay beyond the call deadline still reports `rate_limited`.
- M1: The sticker state creation description specifies epoch seconds.
