# Implementation report

Date: 2026-10-17. Status: all 66 tools implemented; gates `npm run check` (8 test files, 194 tests), `npm run build` and `npm pack --dry-run` pass locally after the latest code change; `npm pack --dry-run` lists only `dist/**`, `README.md`, `package.json` (44 files, ~37 kB). No live YouGile call was ever made.

## Scope
- Tool total: **66** = 25 read, 29 write, 12 destructive, exactly as ARCHITECTURE §6. Gating: default 25; `ALLOW_WRITES` 54; plus `ALLOW_DESTRUCTIVE` 66. `ALLOW_DESTRUCTIVE` without `ALLOW_WRITES` is a config error.
- Groups: users/company, projects (+ generic `yougile_restore`), roles, departments, boards, columns, tasks, stickers, chats, webhooks. Foundations: config, errors, rate limiter, retry, client with paginate.
- Spec mismatches fixed in ARCHITECTURE (the spec wins over the catalogue):
  - §6.2: `CreateProjectDto`/`UpdateProjectDto` also accept `departments`; the tools expose it.
  - §6.5: `Deadline` requires `deadline` (plus `blockedPoints`, `links`, which the tool fills with `[]`); `TimeTracking` requires `plan` and `work` (a missing one is sent as `0` on create, taken from the stored task on update).
  - §6.7: `UpdateGroupChatDto` also accepts `userRoleMap` and `roleConfigMap`; `UpdateChatMessageDto.react` is a ten-emoji enum (`👍 👎 👏 🙂 😀 😕 🎉 ❤ 🚀 ✔`), not free text.
- Implementation note: `src/tools/_structureKit.ts` is a local helper module for the structure groups that duplicates part of `_shared.ts`; fold it in later.
- List tools for departments, boards, columns and projects send `includeDeleted=false` explicitly by default.

## Tests (no network)
- `test/unit/*`: config, errors, limiter, retry, client/paginate, projections, scaffold smoke.
- `test/tools/structureGroups.test.ts`, `chats-webhooks.test.ts`, and the other per-group tests: per-tool behaviour with stub or fake fetch.
- `test/tools/integrationMatrix.test.ts`: real server + real `YouGileClient` + fake fetch over an in-memory MCP transport. Asserts the exact 25/54/66 name sets, `confirm: true` on all 12 destructive tools, read/destructive annotations, and about 70 table rows of method, path, query and body (stripped partial updates, `idempotencyKey`, restore for every kind, read-modify-write ordering, sanitized errors, empty updates rejected without HTTP).
- Cancellation block in the same file: 17 representative tools (every group) abort the in-flight fetch when the MCP client cancels; passes now that handlers forward `extra.signal`.
- `test/unit/stdioSmoke.test.ts`: spawns the real server (source via tsx; built `dist/index.js` when present) over stdio. Asserts every stdout line is JSON-RPC, `tools/list` returns 66 tools, the key never reaches stderr, and invalid config exits with code 2, empty stdout and one stderr line. `YOUGILE_BASE_URL` points at an unused local port, so nothing is contacted.
- Totals come from the latest `npm run check` run: 8 files, 194 tests, all passing. Earlier in the run `foundation.test.ts` "does not refill during a penalty pause" timed out once at 5 s while other suites ran and passed on re-run; it did not recur in the latest run. Treat it as a possible flake.
- No test, and no part of this documentation pass, contacted the YouGile API.

## Live-only uncertainty (unverified)
1. `GET /companies` against the spec's odd `/companies{*companyId}` path (risk 1). Drop `yougile_get_company` if it 404s.
2. Timestamp unit assumed to be milliseconds (risk 2).
3. Real error body shape and 429 / `Retry-After` on data endpoints (risk 3).
4. A task id is assumed to work as a chat id (risk 4).
5. Deep DTOs (`ProjectPermissionsDto`, `WebhookFilters` value shape for title/chat_message), minimal accepted body of `POST /group-chats`, and whether `GET /webhooks` returns an array.
6. Idempotency: the key is sent in the request body only (no header). Whether the vendor deduplicates on it is unconfirmed live.

## Receipts
Orca run `run_e31865866c07`. Ids are from `orca orchestration worker-list`; all rows below show dispatch `completed` / outcome `succeeded`. Model receipts: for the foundation worker, `orca orchestration worker-show ctx_401d0d3db725` recorded `launch.effective` codex / `gpt-6-luna` and a provider projection of `gpt-6-luna`. For Claude workers, `launch.effective` is `sonnet` and the projection model is `null`, so the specific Claude model names below are as requested or self-reported, not confirmed by Orca.

| Role | Agent | Orca task / dispatch | Outcome |
|---|---|---|---|
| Architecture lead | Claude Opus (`claude-opus-5-5`) | task_4572bb183e60 / ctx_96d4e7a09052 | ARCHITECTURE + handoff (not in the run's current worker-list) |
| Foundations | Codex, `gpt-6-luna` (per `worker-show`) | task_102982b6622e / ctx_401d0d3db725 | config, errors, limiter, retry, client/paginate, shared tool helpers |
| Structure groups | Claude Code, `claude-sonnet-5-5` | task_ae0bc9c29271 / ctx_c826146b9d97 | users, company, projects, roles, departments, boards, columns + `structureGroups.test.ts` |
| Tasks and stickers | Claude Code, `claude-sonnet-5-5` | task_f7cd2ee4e282 / ctx_35b87d018325 | task and sticker tools + their tests |
| Chats and webhooks | Claude Code, `claude-sonnet-5-5` | task_3b028878bae5 / ctx_b43910f7fdbc | chat and webhook tools + `chats-webhooks.test.ts` |
| Integration, docs | Claude Code, `claude-sonnet-5-5` | task_391609802508 / ctx_8088e7d34e20 | integration matrix, stdio smoke, README / IMPLEMENTATION / first report |
| Follow-up hardening 1 | coordinator-dispatched worker | task_9dee26c10b68 / ctx_524630453bc5 | foundation audit; settled `succeeded` |
| Follow-up hardening 2 | coordinator-dispatched worker | task_58b8f87bc142 / ctx_bb5be5f6df5f | chat/webhook hardening; settled `succeeded` |
| Follow-up hardening 3 | coordinator-dispatched worker | task_f7fd872116ec / ctx_26d1dd0ed1f5 | pagination/limiter; settled `succeeded` |
| Follow-up hardening 4 | coordinator-dispatched worker | task_b7d1acf4d692 / ctx_1cab15b10373 | task/sticker hardening; settled `succeeded` |
| Follow-up hardening 5 | coordinator-dispatched worker | task_c4b76867f6a2 / ctx_90b0085ddecf | structure cancellation; settled `succeeded` |
| Follow-up hardening 6 | coordinator-dispatched worker | task_b41b1a7e861f / ctx_eba886f80d30 | HTTP unknown outcome and idempotency body; settled `succeeded` |
| Shared task deadline | coordinator-dispatched worker | task_484067b12f58 / ctx_2b304b51bc67 | one `AbortSignal.any` per task/sticker tool handler so GET+PUT and pagination share a single deadline; test added; per worker report: `npm run check` 194 tests and `npm run build` pass; settled `succeeded` |
| Formatting | Claude Code, Sonnet (`launch.effective` per coordinator; model not Orca-confirmed) | task_6239c167031b / ctx_1c6a5ebc984f | source/test/README formatting; per coordinator: 17 files formatted, `prettier --check src test README.md` clean, `npm run check` 194 tests and `npm run build` pass; settled `succeeded` |
| Final documentation accuracy pass | Claude Code, `claude-sonnet-5-5` | task_b0a08c493329 / ctx_397df6e2afbf | this update: ARCHITECTURE §6.5/§6.7 corrections, report, checklist |
