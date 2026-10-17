# Implementation checklist

Status: the implementation is complete and every step below is done except the manual live verification in section 4, which has not been run. This file is kept as the record of the steps. `docs/ARCHITECTURE.md` is authoritative; section numbers refer to it. `src/` contains no `not implemented` stubs or `TODO(implementer)` markers. See `docs/implementation-report.md` for results, receipts and live-only uncertainties. Run `npm run check` after any change.

## 0. Preflight
- [x] Re-check the OpenAPI spec SHA-256 against the provenance file in `docs/research/raw/` (§10 risk 6). If it changed, stop and report.

## 1. Foundations
- [x] `src/config.ts` (§3): finish bounds, https/localhost rule, `ALLOW_DESTRUCTIVE` requires `ALLOW_WRITES`, frozen result; tests for defaults, bounds, secret-free errors. (A minimal version exists.)
- [x] `src/http/errors.ts` (§5.4, §5.3): `ErrorCode` incl. `unknown_outcome`, status mapping, `toToolError` (hints, 300-char cap, key scrubbing, no URLs/stacks/HTML); unit tests.
- [x] `src/http/rateLimiter.ts` (§5.1): token bucket `ceil(perMin/4)`, refill `perMin/60000`/ms, FIFO waiters, abort removes waiter, `penalize`; fake-clock tests.
- [x] `src/http/retry.ts` (§5.3): `isRetryable`, `backoffMs` (500ms·2^n, full jitter, cap 8s), `parseRetryAfter` (seconds / HTTP date); tests for the retry matrix.
- [x] `src/http/client.ts` (§4.1, §5.1–5.3): `request()` with `/api-v2` prefix, Bearer auth, per-attempt timeout + `AbortSignal.any`, overall deadline `max(60s, 4*timeoutMs)`, limiter on every attempt, retries per matrix, `idempotencyKey` reuse, error mapping; `paginate()` (§5.5: page size ≤1000, walks `paging.next`, `maxItems`, `truncated`). Optionally add `get/post/put/del` helpers.
- [x] `src/format/project.ts` (§5.6): `taskSummary`, `taskDetail`, `<name>Iso` timestamps.
- [x] `src/tools/_shared.ts` (§5.5–5.7, §6 notation, §7): `EpochMs` preprocess, result helper (`content` + `structuredContent`), annotation presets, list-result/paging helper, strip-undefined, "at least one field" guard, `defineTool()` using `registerTool`.

## 2. Tools (each group: read always; write/destructive gated; tests per tool: method/path/query/body)
- [x] `tools/users.ts` (§6.1): whoami, list_users, get_user, invite_user, update_user, remove_user (D, real `DELETE`).
- [x] `tools/company.ts` (§6.1, §10 risk 1): get_company (`GET /companies`; drop if live check 404s).
- [x] `tools/projects.ts` (§6.2, §6.9, §6.5 restore): list/get/create (idempotencyKey)/update, delete_project (D), `yougile_restore` (W, all kinds).
- [x] `tools/roles.ts` (§6.2): list/get/create/update, delete_project_role (D, real `DELETE`).
- [x] `tools/departments.ts` (§6.3, §6.9): list/get/create/update, delete_department (D).
- [x] `tools/boards.ts` (§6.4, §6.9): list/get/create (idempotencyKey)/update, delete_board (D).
- [x] `tools/columns.ts` (§6.4, §6.9): list/get/create (idempotencyKey)/update, delete_column (D).
- [x] `tools/tasks.ts` (§6.5, §7): list_tasks (`/task-list`, `fetchAll`), get_task, get_task_log (cursor), chat subscribers get/set (check DTO field name in the spec), create/update/move, set_task_checklists and set_task_subtasks (re-read before PUT), delete_task (D).
- [x] `tools/stickers.ts` (§6.6, §6.9): discriminated string/sprint union, state create/update, delete_sticker and delete_sticker_state (D).
- [x] `tools/chats.ts` (§6.7, §6.9): group chats (fill `userRoleMap`/`roleConfigMap`), messages list/get/send (default `textHtml`, `label`)/update, delete_message and delete_group_chat (D).
- [x] `tools/webhooks.ts` (§6.8): list/create (https only)/update, delete_webhook (D).
- [x] Register all groups in `src/server.ts` (already wired); confirm the total is **66 tools = 25 R, 29 W, 12 D**.

## 3. Cross-cutting tests (§8)
- [x] Gating sets per env combination (names and counts) via `InMemoryTransport.createLinkedPair()`, `listTools`, `callTool`.
- [x] Table-driven request assertions over §6; undefined fields stripped; read-modify-write ordering; error results have `isError: true`.
- [x] stdout hygiene: starting `dist/index.js` emits only JSON-RPC on stdout.

## 4. Live verification (once, sandbox company, manual, not CI)
- [ ] `npm run inspect`; verify §10 risks 1–3 (company path, ms timestamps, error body / 429 shape) and risk 4 (task id as chat id). Record findings in the architecture lead's doc, not here. Also unconfirmed live: the minimal accepted `POST /group-chats` body, `GET /webhooks` response shape, and the `Deadline`/`TimeTracking` bodies sent on update. No live call has been made.

## 5. Done criteria
- [x] `npm run check` and `npm run build` pass; README env table matches `config.ts`; no `console.log`; no endpoints outside the spec.

## QA follow-up (2026-10-17)
Offline regressions now cover sprint seconds, strict ISO input, partial `fetchAll` deadlines, bounded 429 handling, webhook regex input, and 2xx response parsing. `YOUGILE_LOG_LEVEL` is reserved as documented in ARCHITECTURE; runtime stacks are not emitted because they can contain credentials or URLs.
