> **Historical.** Superseded by `FINAL.md` (2026-10-17).

# QA report: yougile-mcp (independent audit)

Date: 2026-10-17. QA lead: Claude Opus (`claude-opus-5-5`, self-reported). Scope: this checkout only. No live YouGile
calls or credentials were used, nothing was committed, and no production `src/**` or implementer-owned docs were changed.

## Verdict

**Not yet a pass. There is one actionable P1 and four P2s, all reproduced offline.** Gating (25/54/66), stdout purity,
secret redaction, config validation, retry bounds and the spec mapping of methods and paths are sound. None of the
findings is a security issue. After the P1 (sprint dates sent in the wrong unit) and the P2s are fixed, a retest should
be enough to pass.

## Gate evidence (final run after all reviewers finished)

| Command | Result |
|---|---|
| `npm run check` (`tsc --noEmit && eslint . && vitest run`) | exit 0. **13 files, 199 passed, 7 expected-fail (206)** |
| `npm run build` | exit 0, `dist/index.js` has a shebang and mode 755 |
| `npm pack --dry-run` | 44 files, 38.1 kB packed, only `dist/**`, `README.md`, `package.json` |
| Baseline before QA tests were added | 8 files, 194 passed (matches `docs/implementation-report.md`) |

The 7 expected-fails are `it.fails` reproductions of the defects below (Opus 4, Haiku 3). Each was also run as a plain
`it` to confirm it fails on the intended assertion. **When a fix lands, vitest reports that `it.fails` as failing. That is
the signal to change it to `it`.** QA added 12 tests in total: Opus 4, Haiku 6 (including the 66-tool spec sweep) and
Codex 2.

### Spawned stdio integration (built `dist/index.js`, loopback fixture on 127.0.0.1)
Opus ran its own harness (scratchpad script, not checked in). Codex Sol's `test/qa/codex/stdio-loopback.test.ts` covers the same ground inside the suite.
- `tools/list`: **25** (default), **54** (`ALLOW_WRITES`), **66** (`+ALLOW_DESTRUCTIVE`).
- Every stdout line is JSON-RPC 2.0, with 0 non-protocol lines. The key never appears on stdout or stderr. Every request carried `Authorization: Bearer <key>`.
- A 401 with an HTML body containing the key and a URL returned `YouGile auth (HTTP 401): Unauthorized; check YOUGILE_API_KEY`. A 500 `{message:"boom <key>"}` returned `YouGile server (HTTP 500): boom [redacted]`.
- SIGTERM exits 0 within about 16 ms, and closing stdin exits 0. `ALLOW_DESTRUCTIVE` without writes, and `YOUGILE_BASE_URL=http://evil.example`, each exit **2** with one stderr line and empty stdout.

## Findings (prioritized)

### P1-1 · Sprint sticker `begin`/`end` are sent in milliseconds, but the spec defines seconds (Haiku F1; verified by Opus)
- **Where:** `src/tools/stickers.ts:178-179` (create sticker states), `:244-245` (create state) and `:278-279` (update state). All three use `EpochMs` (`src/tools/tasks.ts:13-24`, ms). The description at `stickers.ts:168` says "epoch ms".
- **Spec:** `SprintStickerStateDto`, `CreateSprintStickerStateDto` and `UpdateSprintStickerStateDto` describe `begin`/`end` as "Дата … спринта в секундах от 01.01.1970", with example `1655989112`. Opus confirmed this by querying `components.schemas` in `docs/research/raw/yougile-openapi-v2.json`.
- **Repro:** `npx vitest run test/qa/haiku/findings.test.ts`. As a plain `it`: `expected 1767225600000 to be 1767225600`. The existing `test/tools/stickers.tools.test.ts:87,91` locks in the wrong unit, since it expects `begin: 1000` for `1970-01-01T00:00:01Z`.
- **Impact:** every sprint date written by the tool would land thousands of years in the future.
- **Fix:** convert ISO input to `Math.floor(ms/1000)`, describe the field as seconds, and update `stickers.tools.test.ts`.

### P2-1 · `fetchAll` drops the partial results when the per-call deadline fires (Opus QA-1)
- **Where:** `src/tools/tasks.ts:163-166` creates the guard signal `AbortSignal.timeout(max(60s, 4·timeoutMs))` and passes it into `client.paginate`. In `src/http/client.ts:186-187`, `if (opts.signal?.aborted) throw error;` then treats the deadline like a user cancel. The paginate deadline (`client.ts:155`) is computed a little later than the guard's, so the guard always fires first.
- **ARCH §5.2:** "For a paginated read it instead returns the partial results with `truncated: true` and the next offset."
- **Repro:** `test/qa/opus/regressions.test.ts` "QA-1". Page 1 returns `t1` with `next:true` and page 2 hangs until the 60 s deadline fires. Actual result: `{"isError":true,"text":"YouGile timeout: Request timed out"}` after 2 fetches, so page 1 is lost.
- **Fix:** when the abort reason is a `TimeoutError` rather than a client cancel, return the partial page. Another option is to let paginate own the deadline.

### P2-2 · A 429 on a non-idempotent write becomes `unknown_outcome` when Retry-After outlasts the deadline (Codex Sol)
- **Where:** `src/http/client.ts:116` calls `wait(...)`, which rejects with `timeout` when the deadline fires. The catch at `:117-135` sees `e !== last` and a non-idempotent method, then throws `unknown_outcome`.
- **Repro:** `npx vitest run test/qa/codex/http-review.test.ts`. A POST `/chats/id/messages` gets a 429 with `Retry-After: 3600` and a 30 ms deadline, makes exactly 1 fetch, and rejects with `{code:'unknown_outcome', status:null}`.
- **Impact:** the 429 shows the write was rejected, but the model is told it "may have completed". This also applies to PUT and DELETE.
- **Note:** Codex's test currently *asserts the buggy outcome* (characterization). Flip it to expect `rate_limited`/429 (or `timeout`) together with the fix.

### P2-3 · An unbounded `Retry-After` stops every later call (Opus QA-2)
- **Where:** `src/http/client.ts:79-81` calls `limiter.penalize(retryAfter)` with no cap, and `src/http/rateLimiter.ts:37-42` pauses all refills for that long. `parseRetryAfter` (`retry.ts:31-37`) accepts any value.
- **Repro:** "QA-2". After one 429 with `Retry-After: 86400`, an unrelated `GET /b` never reaches fetch: 1 fetch call in total, and it rejects with `timeout` (about 600 ms in the probe). In production every tool call would wait out its 60 s deadline and fail for 24 h, until the process restarts.
- **Fix:** cap the penalty, for example at the per-call deadline or 60 s, and fail fast with `rate_limited` when the wait exceeds the remaining deadline.

### P2-4 · Webhook `event` rejects the JS regexp alternation that the spec permits (Haiku F2)
- **Where:** `src/tools/webhooks.ts:6-10` (`/^[a-z_.*-]+$/`). The spec's `CreateWebhookDto.event` says "Может использоваться javascript regexp как значение".
- **Repro:** `test/qa/haiku/findings.test.ts:97-110`. `event: 'task-(created|deleted)'` gives `isError`. The forms `task-*`, `.*` and `task-created` pass.
- **Fix:** widen the regex, or have the architecture lead record the narrower rule in ARCH §6.8. A workaround exists, which is why this is P2 and not P1.

### P3-1 · A 2xx with a non-JSON or empty body is misclassified (Opus QA-3)
- **Where:** `src/http/client.ts:78`. A `response.json()` SyntaxError falls into the network-error catch.
- **Repro:** "QA-3". GET `200 <html>proxy page</html>` is fetched **3 times** and ends as `network: Network request failed`. A PUT that got 200 with an empty body reports `unknown_outcome` although the server accepted it.
- **Impact:** low against YouGile cloud (it returns JSON). It is realistic behind on-prem proxies and SSO pages.

### P3-2 · `YOUGILE_LOG_LEVEL` is a no-op, and unexpected exceptions are never logged (Haiku F3; confirmed by Opus)
- `grep -rn "console\.\|logLevel" src` finds only `src/index.ts:29,32` and the config definition. ARCH §5.4 requires unexpected exceptions to be logged to stderr at `debug` with the stack. Today `toToolError` returns `unknown: Unexpected error` with no trace anywhere.

### P3-3 · `EpochMs` accepts loosely parsed strings (Opus)
- `Date.parse` is lenient. `"1"` parses to 2001-01-01 local time, `"2026"` to 2026-01-01, and `"2026-10-20T10:00"` (no zone) uses the **server's** local time zone. A numeric string such as `"1700000000000"` is rejected, which is the safe outcome. Suggestion: accept only ISO-8601 with a date component, and document that a missing zone means server-local time. (`src/tools/tasks.ts:13-24`, `src/tools/_shared.ts:15-19`.)

### Spec ambiguities to record, not defects (Haiku F4–F6)
- `WebhookFilters.name` is typed as an array in the spec while the example is a scalar. The code follows the description.
- `CheckList.items` is a single `allOf` object while its description says array. The code uses an array.
- `GET /companies` is in the spec only as `/companies{*companyId}` (ARCH §10 risk 1).

## Checked and passing (no finding)
- All 66 tools map to the spec method and path. No endpoint is outside the spec, no body key is undefined by the spec, and no spec-required key is missing. This comes from Haiku's sweep `test/qa/haiku/spec-conformance.test.ts`, which was checked for sensitivity with three injected faults. `idempotencyKey` appears only on the 4 spec creates.
- There is no generic HTTP tool, and real `DELETE` is used only for `remove_user` and `delete_project_role`. `confirm: z.literal(true)` is on all 12 destructive tools.
- Every attempt, including retries, calls `limiter.acquire(signal)` (`client.ts:59`). Bounds: GET and idempotent POST make 3 attempts, PUT/DELETE/plain POST make 2 and only on 429. A timeout or 5xx on a write gives `unknown_outcome`. Waiters are removed on abort.
- The README key-creation `curl` (`/auth/companies`, `/auth/keys`) matches the spec DTOs. Env names, defaults and ranges match `src/config.ts`.

## Live-only uncertainties (not verifiable offline)
1. Whether bare `GET /companies` works (ARCH §10.1).
2. Millisecond units for task timestamps (ARCH §10.2). Sprint dates are seconds per the spec, see P1-1.
3. The real error body shape, and 429 / `Retry-After` behaviour and magnitudes on data endpoints.
4. Whether a task id works as a chat id. The minimal body for `POST /group-chats`. `ProjectPermissionsDto` and the `WebhookFilters` value shape.
5. Whether the vendor deduplicates on a body `idempotencyKey`.

## Files produced by QA (no production files changed)
- `docs/qa/REPORT.md` (this file), `docs/qa/haiku-findings.md`, `docs/qa/codex-findings.md`
- `test/qa/opus/regressions.test.ts` (4 `it.fails`), `test/qa/haiku/{spec-conformance,findings}.test.ts`, `test/qa/codex/{http-review,stdio-loopback}.test.ts`
- An mtime check found no change under `src/`, `README.md`, `package.json` or the implementer docs during this run.

## Model receipts (Orca run `run_b385b7ba2ebb`, current worktree only)
| Role | Orca task / dispatch | Orca receipt | Self-reported | Outcome |
|---|---|---|---|---|
| QA lead | task_37d47e82e49e / ctx_3a3e37a6de40 | (this dispatch) | Claude Opus `claude-opus-5-5` | this report |
| Spec/DTO/README reviewer | task_e5cfda293ec7 / ctx_41279565148e | started with `--agent claude --model claude-haiku-5-5`; `worker-list` projection `provider.id=claude`, `provider.model=null` (not Orca-confirmed) | Haiku 5.5 `claude-haiku-5-5` | succeeded, completed, terminal released |
| HTTP/transport/security reviewer | task_605d1514b2d0 / ctx_61cbe2c7f9b2 | `worker-start` effective `model=gpt-6-sol`; `worker-list` projection `provider.id=codex`, `provider.model=gpt-6-sol` | "GPT-6.1-sol" | succeeded, completed, terminal released |

Before Codex launched, `orca account list --json` showed `rateLimits.codex.session.usedPercent = 32` (threshold 85), so the launch was allowed.
