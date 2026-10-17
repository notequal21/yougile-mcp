> **Historical.** Superseded by `FINAL.md` (2026-10-17).

# Final QA retest — independent (Claude Opus)

Date: 2026-10-17. Scope: verify every item in `FIXES.md` against the original QA intent (`REPORT.md`, `haiku-findings.md`,
`codex-findings.md`). Local only: no live YouGile calls, no src edits. `REPORT.md` is kept as history; this file is the final verdict.

## Verdict: **NOT PASSED — 2 actionable items (P2), 2 minor items**

## Process proof
| Gate | Result |
|---|---|
| `npm run check` (tsc + eslint + vitest) | 13 files, **209/209 passed** |
| `npm run build` | ok |
| Spawned stdio integration (`test/unit/stdioSmoke.test.ts`) | 4/4 passed (the `skipIf` guards only a missing build; build existed) |
| `grep it.fails / .skip / .todo / xit` in `test/` | none (only the conditional `skipIf` above) |
| `npm pack --dry-run` | 44 files, ok |
| `prettier --check .` | only `AGENTS.md` flagged (docs formatting, not code) |

## Fix-by-fix verification
| Finding | Status | Evidence |
|---|---|---|
| P1-1 sprint dates in seconds | Fixed | `stickers.ts` `EpochSeconds`: integers pass through as seconds, ISO → `floor(ms/1000)`. See minor M1 (description). |
| P2-1 pagination timeout vs cancel | Fixed | `client.ts` `paginate`: deadline `TimeoutError` → partial `truncated:true`; caller abort with a non-Timeout reason rethrows. |
| P2-2 429 beyond deadline | Fixed | `client.ts`: 429 with `Retry-After >= remaining deadline` throws the known `rate_limited` error. |
| P2-3 bounded Retry-After | **Overcorrected** (see R2) | Limiter penalty only when `Retry-After < 60s`, capped at 1 s; per-call backoff still honours the header within the deadline. |
| P2-4 webhook regexp | Fixed | `webhooks.ts` validates with `new RegExp` (alternation accepted, invalid rejected). |
| P3-1 empty / non-JSON 2xx | Fixed | Empty body → `undefined`; non-JSON 2xx → `YouGileError(code 'unknown')`, thrown directly (`instanceof YouGileError` branch), so it is not retried. |
| P3-2 log level | Accepted | `YOUGILE_LOG_LEVEL` honestly documented as reserved. |
| P3-3 strict ISO dates | **Regressed** | See R1. |
| Haiku F4–F6 | Accepted | Recorded in ARCHITECTURE as spec notes; no live verification authorised. |

## New actionable items
### R1 (P2) — valid offset datetimes rejected by `EpochMs` (`src/tools/tasks.ts:22`)
The calendar check compares `new Date(ms).toISOString().slice(0,10)` (UTC date) with the input's local date. Any
timezone-explicit datetime whose UTC date differs from its local date is rejected, though FIXES P3-3 says such input is accepted.
Repro (same regexp + check, node):
```
2026-10-20T00:30:00+05:00 -> rejected (UTC 2026-10-19)
2026-10-20T23:30:00-05:00 -> rejected (UTC 2026-10-21)
2026-10-20T12:00:00Z      -> accepted
2026-02-30                -> rejected (correct)
```
Affects task deadlines/timers and the sprint `EpochSeconds` built on it. Fix: validate the calendar date from the parsed
Y-M-D parts (e.g. `Date.UTC(y,m-1,d)` round-trip) instead of the UTC date of the instant. Add regression tests for `+05:00` / `-05:00`.

### R2 (P2) — Retry-After penalty capped at 1 s (`src/http/client.ts:89-91`)
The shared limiter penalty is `min(1000, retryAfter)` and is skipped when `Retry-After >= 60s`. A server `Retry-After: 10`
therefore pauses other same-company calls for only 1 s, so unrelated calls hit YouGile again inside the window the server asked to
be quiet. That contradicts ARCHITECTURE §5.2 (`penalize(retryAfterMs ?? …)`) and the original QA recommendation (bound the
value, e.g. to 60 s or the remaining deadline, rather than ignore it). Fix: `penalize(min(retryAfter, 60_000))` (and the default
when absent). Add a fake-clock test: after `Retry-After: 10` an unrelated `acquire()` waits about 10 s; after `Retry-After: 86400`
it waits at most 60 s. The QA-2 test (`test/qa/opus/regressions.test.ts:61`) should assert this bound with a fake clock instead of
requiring the next call to go out immediately.

### M1 (P3) — sticker state description says "epoch ms" (`src/tools/stickers.ts:243`)
`create_sticker_state` describes begin/end as "epoch ms or ISO-8601", but the schema is `EpochSeconds`. A model following the
description sends milliseconds, which are forwarded unchanged as seconds (year ~58000). Change the text to "epoch seconds".

### M2 (P3) — `_shared.ts` `EpochMs` is laxer than the tasks one
`src/tools/_shared.ts:15` accepts `2026-02-30` (`Date.parse` rolls to 2026-03-02) and any finite number, including negative or
fractional. Inconsistent with P3-3 "strict ISO"; reuse the tasks validator after fixing R1.

## Local / live limitations
No live YouGile requests; HTTP behaviour verified via code review and the fake-fetch suites only.
