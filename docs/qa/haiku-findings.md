# QA findings: spec conformance of the 66 tools and README setup (Haiku)

- **Reviewer model (self-reported):** Haiku 5.5, model ID `claude-haiku-5-5`
- **Date:** 2026-10-17
- **Scope:** every tool in `src/tools/*.ts` against `docs/research/raw/yougile-openapi-v2.json` and
  `docs/ARCHITECTURE.md` §6; README setup against `src/config.ts`, `src/index.ts` and `package.json`.
- **Rules followed:** no `src/**`, README, `package.json` or existing-test edits; no live YouGile calls, credentials or
  commits; network limited to in-process fakes.

## Gate results

| Command | Result |
|---|---|
| `npm run check` (`tsc --noEmit && eslint . && vitest run`) | **exit 0.** tsc and eslint clean. vitest: 13 files, **199 passed, 7 expected-fail** (3 are mine, see below; the other 4 are `it.fails` in `test/qa/opus/regressions.test.ts`, not reviewed by me). |
| `npm run build` | **exit 0.** `dist/index.js` produced and marked executable. |

## Method

1. Read `AGENTS.md`, `docs/ARCHITECTURE.md`, every `src/tools/*.ts`, `src/http/*.ts`, `src/config.ts`, `src/server.ts`,
   `src/index.ts`, `src/format/project.ts`, `README.md`, `package.json`.
2. Extracted all 41 spec paths / 70 operations and the DTO schemas (scratch dump outside the repo).
3. **Sweep** (`test/qa/haiku/spec-conformance.test.ts`): connects an in-memory MCP client to a server with all gates
   open, invokes each of the 66 tools with a spec-shaped input (plus extra restore kinds and sprint-sticker variants),
   records every HTTP request through a fake fetch, and validates it against the spec:
   method and path template, query names and types, body keys (no undefined keys), spec-required keys (recursively),
   and string enums.
   - Sensitivity check: I injected three known-bad calls (an unknown body key, a missing required key, an
     undefined endpoint). The validator flagged all three, then I removed the injection.
4. **Targeted reproductions** (`test/qa/haiku/findings.test.ts`): `it.fails` marks a reproduced defect. Each one was also
   run as a plain `it` to confirm it fails on the intended assertion (output in the findings below).
5. Mechanical checks: enum parity (42 sticker icons, 10 reactions, 9 task colors) against the spec; confirm literals on
   the 12 destructive tools; real `DELETE` usage; single `fetch` call site; env var use.

## Coverage: 66 tools

Gate counts match ARCHITECTURE §6 and README: **25 read, 29 write, 12 destructive = 66** (`integrationMatrix.test.ts`
already pins these sets, and the sweep confirms every registered name is exercised). Every tool maps to a spec
operation with the spec method and path, and every body and query passes the validator. The one ARCH name without a
tool is `yougile_upload_file` (deferred to v1.1 by design, ARCH §6.10).

| Module | Tools (method and spec path) |
|---|---|
| users.ts | whoami `GET /users/me`; list `GET /users`; get `GET /users/{id}`; invite `POST /users`; update `PUT /users/{id}`; remove `DELETE /users/{id}` |
| company.ts | get_company `GET /companies` (see F6) |
| projects.ts | list `GET /projects`; get `GET /projects/{id}`; create `POST /projects`; update `PUT /projects/{id}`; restore `PUT /<kind>/{id}`; delete `PUT /projects/{id} {deleted:true}` |
| roles.ts | list/get/create/update `…/projects/{projectId}/roles[/{id}]`; delete `DELETE …/roles/{id}` |
| departments.ts | list/get/create/update `/departments[/{id}]`; delete soft `PUT` |
| boards.ts | list/get/create/update `/boards[/{id}]`; delete soft `PUT` |
| columns.ts | list/get/create/update `/columns[/{id}]`; delete soft `PUT` |
| tasks.ts | list `GET /task-list`; get `GET /tasks/{id}`; log `GET /tasks/{id}/log`; chat-subscribers GET/PUT; create `POST /tasks`; update/move/checklists/subtasks/delete `PUT /tasks/{id}` (checklists and subtasks read-modify-write) |
| stickers.ts | list/get/create/update `/{string,sprint}-stickers[/{id}]`; state create/update `…/{id}/states[/{stateId}]`; delete sticker and state (soft `PUT`) |
| chats.ts | group chats list/get/create/update `/group-chats`; messages list/get/send/update `/chats/{chatId}/messages[/{id}]`; delete message and group chat (soft `PUT`) |
| webhooks.ts | list `GET /webhooks`; create `POST /webhooks`; update and delete `PUT /webhooks/{id}` |

Nested DTOs verified: `Deadline` (required `deadline`, `blockedPoints`, `links`; the tool adds the last two),
`UpdateDeadline` (required `blockedPoints`, `links`; the merge keeps them), `TimeTracking` (both `plan` and `work`
required on create; the tool fills defaults), `UpdateTimeTracking` (none required), `CheckListItem` (`isCompleted`
defaulted), `StickersDto`, `WebhookFilters` (`name`, `value` required), `CreateGroupChatDto` (all four keys required,
the tool sends `{}` defaults), `CreateChatMessageDto` (`text`, `textHtml`, `label` all sent), and
`UpdateChatMessageDto.react` (ten-value enum, matches byte for byte). `idempotencyKey` appears only on the creates the
spec defines it for (tasks, projects, boards, columns).

## Findings (prioritized)

No P0 blockers. No endpoint outside the spec, no body field the spec does not define, and no spec-required field
missing in any tested path.

### F1 · P1 · Sprint sticker dates are sent in milliseconds; the spec defines seconds

- **Where:** `src/tools/stickers.ts:178-179` (create sticker states), `:244-245` (create state), `:278-279` (update
  state). All three use `EpochMs` from `src/tools/tasks.ts:13-24`, which turns an ISO string into `Date.parse(...)`
  milliseconds. The description at `src/tools/stickers.ts:168` tells the model "dates as epoch ms or ISO-8601".
- **Spec:** `components.schemas.SprintStickerStateDto.properties.begin` and `.end` (and the same fields in
  `CreateSprintStickerStateDto` and `UpdateSprintStickerStateDto`). Description: "Дата начала спринта в секундах от
  01.01.1970" = sprint start in **seconds** since 1970-01-01. Example `1655989112` (10 digits). The task `Deadline`
  is a different field, in ms (example `1653029146646`), and the code handles it correctly.
- **Repro:** `npx vitest run test/qa/haiku/findings.test.ts`. Expected-fail test `F1` at `test/qa/haiku/findings.test.ts:68`.
  Run as a plain `it`, it fails with:
  ```
  AssertionError: expected 1767225600000 to be 1767225600 // Object.is equality
  ```
  The current test suite pins the bug: `test/tools/stickers.tools.test.ts:87` sends `begin: '1970-01-01T00:00:01Z'`,
  and `:91` expects `begin: 1000` (ms).
- **Expected:** ISO input becomes whole seconds (`Math.floor(Date.parse(v) / 1000)`), and the description says seconds.
- **Actual:** ms. Sprint dates land about 1000x too far in the future (1767225600000 read as seconds is roughly
  56,000 years after 1970). Numeric input passes through unchanged, so following the tool's "epoch ms" hint produces the same error.
- **Fix owner:** implementation lead (`src/tools/stickers.ts`, plus updating `stickers.tools.test.ts`, which pins the
  wrong unit).

### F2 · P2 · Webhook `event` rejects JavaScript-regexp alternation that the spec permits

- **Where:** `src/tools/webhooks.ts:6-10`: `.regex(/^[a-z_.*-]+$/)`.
- **Spec:** `components.schemas.CreateWebhookDto.properties.event.description`: "Может использоваться javascript regexp
  как значение" (a JavaScript regexp may be used as the value), with examples `task-*` and `.*`.
- **Repro:** `test/qa/haiku/findings.test.ts:97-110`. Expected-fail test. Run as plain `it`, it fails with
  `AssertionError: expected true to be falsy`, meaning `isError` is true for
  `event: 'task-(created|deleted)'`. `task-*`, `.*` and `task-created` are accepted (passing test).
- **Expected:** the spec form is accepted, or the description and ARCH §6.8 state the narrower rule explicitly.
- **Actual:** the regex refuses `(`, `|`, `\`, `?`, `+`, `[`, `]`, `^` and `$`. Workaround: `task-*` covers the same objects.
- **Fix owner:** implementation lead, or the architecture lead to narrow the documented rule.

### F3 · P3 · Logging is not implemented; `YOUGILE_LOG_LEVEL` is parsed and then discarded

- **Where:** `src/config.ts:38` (schema) and `:67` (`logLevel`). There is no reader in `src/`
  (`grep -rn logLevel src` shows only `config.ts`). The only `console.error` calls in `src/` are startup errors in
  `src/index.ts:29` and `:32`.
- **Spec/ARCH:** ARCH §3 (line 56) says "Logs go to stderr only" at the chosen level. ARCH §5.4 (line 158) says
  unexpected exceptions are "logged to stderr at `debug` with the stack".
- **Repro:** `grep -rn "logLevel" src` (only the config definition). Setting `YOUGILE_LOG_LEVEL=debug` has no observable effect.
- **Expected:** a stderr logger honouring the level, or the doc and README updated to say the variable is reserved.
- **Actual:** no logs at all. There is no security impact (nothing leaks), but diagnosing a failure in production is harder.

### F4 · P3 · Spec defect: `WebhookFilters.name` declared as an array (code follows the description)

- **Where:** `src/tools/webhooks.ts:16-19` uses `z.enum(['location','title','chat_message'])` for `name`.
- **Spec:** `components.schemas.WebhookFilters.properties.name` has `"type": "array"` with `"items": {"type": "location"}`,
  but `"example": "location"` and the description "Возможные значения: location, title, chat_message". The spec is
  internally inconsistent. The code follows the description, which I think is the right reading. No runtime check
  possible offline.
- **Action:** the architecture lead should record this choice in ARCH §6.8 (which currently says "spec `WebhookFilters`:
  `{name, value: string[]}`") so the next reviewer does not flag it again.

### F5 · P3 · `CheckList.items` shape is ambiguous in the spec

- **Where:** `src/tools/tasks.ts:104-107` (`Checklist.items` is an array) and `normalizeChecklists` at `:135-151`
  (its comment says the spec types `items` as a single item).
- **Spec:** `components.schemas.CheckList.properties.items` = `{"allOf":[{"$ref":"CheckListItem"}]}` (one object), with
  the description "Массив с чеклистами" (array). The sweep validates the array form (recursing into each element against
  `CheckListItem`, with `isCompleted` present), so there is no offline violation.
- **Action:** confirm the array form against a live sandbox once (ARCH §10 risk 3 family). Not reproducible here.

### F6 · P3 · `yougile_get_company` uses `/companies`, which the spec does not list literally

- **Where:** `src/tools/company.ts:18`. ARCH §10 risk 1 is still open.
- **Spec:** only `GET /api-v2/companies{*companyId}` exists (`CompanyController_get`). The sweep passes because the
  wildcard regex matches the empty suffix, but whether the server accepts a bare `/companies` cannot be verified offline.
- **Action:** keep open until the live check ARCH §10 asks for; otherwise drop the tool.

## README setup audit

| Item | Source of truth | Result |
|---|---|---|
| Company lookup: `POST /api-v2/auth/companies`, body `login`, `password`, `name` | spec `CredentialsWithNameDto`, path `/auth/companies` | **match** |
| Key creation: `POST /api-v2/auth/keys`, body `login`, `password`, `companyId`; response `{"key"}` | spec `CredentialsWithCompanyDto`, `AuthKeyDto` | **match** |
| Env var names and defaults: `YOUGILE_API_KEY`, `_BASE_URL` (`https://yougile.com`), `_ALLOW_WRITES` / `_ALLOW_DESTRUCTIVE` (`false`), `_RATE_LIMIT_PER_MIN` (40, 1–50), `_TIMEOUT_MS` (15000, 1000–60000), `_MAX_ITEMS` (500, 1–5000), `_LOG_LEVEL` (info) | `src/config.ts:30-39` | **match** (ranges and defaults identical) |
| Base URL is origin-only, https required except `localhost` / `127.0.0.1` | `src/config.ts:54-58` | **match** |
| Invalid config: exit code 2, one stderr line, no key value | `src/index.ts:27-33`; checked by running `dist/index.js` with bad values | **match.** Verified: `ALLOW_DESTRUCTIVE` without writes, `http://example.com`, `RATE_LIMIT_PER_MIN=51` and a missing key all exit 2 with one line, and the key was never printed |
| Client config path `dist/index.js` | `tsconfig.build.json` (`outDir: dist`), `package.json` `bin` | **match** |
| npm scripts `build`, `check`, `test`, `start`, `inspect` (README mentions these) | `package.json` | **match.** `scripts/postbuild.mjs` exists |
| Tool counts 25 / 54 / 66 | `integrationMatrix.test.ts` and the sweep | **match** |
| "about 30 keys per account" limit; Ctrl+Alt+Q copy shortcut; Claude Desktop / Cursor / `claude mcp add` syntax | not in the spec or the code | **not verified** (outside the offline scope) |

README gap (not a mismatch): `YOUGILE_LOG_LEVEL` is documented as "logs only in stderr", which holds vacuously because
nothing logs. See F3.

## Not checked or out of scope

- Live YouGile behaviour (none run, per the rules): the `/companies` path (F6), the sprint unit against a real company
  (F1 is spec-based), checklist shape (F5), and webhook filter `name` (F4).
- The other QA folders: `test/qa/opus/regressions.test.ts` has four expected-fail tests (`it.fails`) I did not review.
  One of them ("a PUT that got 200 with an empty body is not reported as unknown_outcome") concerns the HTTP client;
  I did not re-verify it.
- Retry and rate-limit semantics beyond my reading of `src/http/client.ts`, which matches ARCH §5.1–5.3 on
  read: idempotent-POST retries, PUT and non-idempotent write `unknown_outcome`, 429 penalty.

## Files

- `test/qa/haiku/spec-conformance.test.ts` (new): the sweep across 66 tools. Passes.
- `test/qa/haiku/findings.test.ts` (new): five tests. Three are `it.fails` reproductions (F1 ×2 at lines 55 and 72,
  F2 ×1 at line 97). Two are passing controls: the current ms behaviour for F1 and the documented webhook forms for F2.
  With the sweep, that is six tests of mine. The 7 expected-fails reported by `npm run check` are these 3 plus the
  4 in `test/qa/opus`.
- `docs/qa/haiku-findings.md` (this report).
- `dist/` was rebuilt by `npm run build` (gitignored).
