# Independent QA findings

Reviewer model (self-reported): **GPT-6.1-sol**.

## P2 — HTTP 429 on a non-idempotent write is misreported as an unknown outcome when Retry-After exceeds the deadline

- **Location:** `src/http/client.ts:79-81`, `src/http/client.ts:110-144`.
- **Reproduction:** `npx vitest run test/qa/codex/http-review.test.ts` → `Test Files 1 passed (1); Tests 1 passed (1)`. The assertion at `test/qa/codex/http-review.test.ts:16-22` sends one plain POST through fake fetch, receives HTTP 429 with `Retry-After: 3600`, and observes `{ code: 'unknown_outcome', status: null }` after the deadline. The recorder confirms exactly one HTTP attempt.
- **Expected:** The rejected HTTP 429 should remain identifiable as `rate_limited` with status 429 (or a timeout while waiting for the retry), so callers do not infer that the write may have succeeded.
- **Actual:** The deadline aborts the retry wait; the generic catch path treats that as an uncertain write outcome and discards the known 429 response and status. The same path applies to PUT and DELETE.

## Verification

- `npm run build` → exit 0 (`tsc -p tsconfig.build.json && node scripts/postbuild.mjs`).
- `npm run check` → exit 0 (`Test Files 10 passed (10); Tests 196 passed (196)`).
- `test/qa/codex/stdio-loopback.test.ts:8-76` spawned built `dist/index.js` against a local `127.0.0.1` fixture, exercised `initialize`, `tools/list`, and `tools/call`, and asserted 25/54/66 tools, JSON-RPC-only stdout, key-free stderr, and exit 0 on SIGTERM. It passed in the above check run.
- Existing config and retry tests plus source review covered the remaining requested areas. No other finding is reported without a reproduced failure.

No live YouGile calls were made.
