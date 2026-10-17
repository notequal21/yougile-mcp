# Final acceptance — R1/R2/M1/M2 (Claude Opus)

Date: 2026-10-17. Scope: the four items left open by `RETEST.md`. Local only: no live YouGile calls, no src edits, no network.
`REPORT.md` and `RETEST.md` are historical; this file is the verdict.

## Verdict: **PASS**

## Gates
| Gate | Result |
|---|---|
| `npm run check` (tsc + eslint + vitest) | 14 files, **220/220 passed** |
| `npm run build` | ok |
| stdio loopback (`test/unit/stdioSmoke.test.ts`, `test/qa/codex/stdio-loopback.test.ts`) | 2 files, 5/5 passed against built `dist` |
| `it.fails` / `.skip(` / `.todo(` / `xit(` in `test/` | none — no expected failures; original QA regressions run as normal passing tests |

## Item verification
| Item | Status | Evidence |
|---|---|---|
| R1 offset datetimes crossing UTC day | Fixed | `src/tools/_shared.ts` `EpochMs` validates Y-M-D parts, then `Date.parse`. Probe on `dist`: `2026-10-20T00:30:00+05:00` → `2026-10-19T19:30:00.000Z`; `2026-10-20T23:30:00-05:00` → `2026-10-21T04:30:00.000Z`. Tests: `test/unit/epochMs.test.ts`. |
| M2 one strict validator for all consumers | Fixed | Single `EpochMs` in `_shared.ts`, used by `tasks.ts` (deadline/startDate), `chats.ts` (`since`), `stickers.ts` (`EpochSeconds` pipes through it). Rejected: `2026-02-30`, `2026-02-30T10:00:00Z`, `T24:00:00Z`, `-1`, `1.5`. |
| R2 429 pauses shared limiter | Fixed | `src/http/client.ts:89-92`: `penalize(min(retryAfter ?? default, 60_000))` on any 429. Fake-clock test `test/qa/opus/regressions.test.ts:60`: `Retry-After: 10` blocks an unrelated `acquire()` for 10 s; `86400` caps at 60 s. Beyond-deadline 429 still throws `rate_limited`. |
| M1 sticker state seconds | Fixed | `src/tools/stickers.ts:242` description reads "epoch seconds or ISO-8601"; schema `EpochSeconds`. |

## Outstanding
None blocking. The server is a complete local stdio MCP server, ready for the user to add `YOUGILE_API_KEY` (key created manually per README).

## Live vendor caveats
Not verified against live YouGile: real 429/`Retry-After` behaviour, sprint sticker date units in seconds, and Haiku F4–F6 spec notes
rest on the OpenAPI spec and fake-fetch tests only. First live use should be read-only, then writes with `allowWrites`.
