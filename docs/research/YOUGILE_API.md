# YouGile REST API v2 — research for MCP server architecture

Retrieved: **2026-10-17**. Primary evidence: the vendor's own OpenAPI document, saved unmodified at
[`raw/yougile-openapi-v2.json`](raw/yougile-openapi-v2.json) (see
[`raw/yougile-openapi-v2.provenance.txt`](raw/yougile-openapi-v2.provenance.txt) for URL, timestamp, SHA-256).
All web/spec text was treated as untrusted data. Anything not backed by the spec or another official page is marked **UNVERIFIED**.

Child notes (Haiku researchers, kept for traceability): [`notes-schemas-errors-limits.md`](notes-schemas-errors-limits.md)
(written before the spec was obtained, so most of its items say UNVERIFIED; this file supersedes it), and
`notes-auth-endpoints.md` if present.

## 1. Sources

| ID | URL | What it is | Status |
|----|-----|-----------|--------|
| S1 | https://ru.yougile.com/api-json | Official OpenAPI 3.0.0 doc, `info.title` "YouGile REST API v2.0" | **Fetched**, saved to `raw/`. Must use `curl --compressed`; the uncompressed transfer stalled. |
| S2 | https://yougile.com/api-v2 | Official reference page (Stoplight Elements, `apiDescriptionUrl="/api-json"`) | Fetched HTML shell; it confirms S1 is the page's data source. |
| S3 | https://ru.yougile.com/api-v2 | Same reference on the RU host | Renders client-side; content = S1 |
| S4 | https://docs.yougile.com/docs/admin-guide-windows/api/ (also `admin-guide-linux/api/`) | Official on-prem admin guide, REST API page | Read secondhand via a summarizing fetch by a child worker. It is consistent with S1. |
| S5 | https://ru.yougile.com/news/2022-08-03_api_2.html | v2 announcement | **Not retrieved** (socket closed) |

The spec has `servers: []`. The canonical base URL comes from the spec's description text: `https://yougile.com/api-v2/{resource}`.
On-prem installs use `https://<own domain>/api-v2/...` (S4). The spec examples show `http://localhost:8001`, which is only a vendor-internal example.

## 2. Auth / token setup

From S1 `info.description` and `components.securitySchemes.bearer` (http bearer, bearerFormat "JWT").

1. `POST /api-v2/auth/companies?limit&offset`. Body: `{login, password, name?}` (CredentialsWithNameDto). Returns `CompanyListDto` = `{paging, content:[{id,title,timestamp,...}]}`. No bearer token needed.
2. `POST /api-v2/auth/keys`. Body: `{login, password, companyId}`. Returns **201** `{key}`. No bearer token needed.
3. On every other call, send `Authorization: Bearer <key>` and `Content-Type: application/json`.
4. Key management (no bearer): `POST /api-v2/auth/keys/get` with body `{login, password, companyId?}` returns a list of `{key, companyId, timestamp, deleted}`. `DELETE /api-v2/auth/keys/{key}` deletes a key.

Constraints (S1 text):
- Keys **do not expire** and have no request quota.
- Each **account** can hold at most **30 keys**.
- API calls run with the key owner's permissions, so anything the user can't do in the UI is also blocked via the API.

**MCP recommendation:** take a pre-issued key from an env var (e.g. `YOUGILE_API_KEY`, plus an optional `YOUGILE_BASE_URL` for on-prem). Do **not** accept a login/password at runtime. If key creation is offered at all, make it a separate one-off CLI helper.

## 3. Conventions

- **Methods:** GET, POST, PUT, DELETE. There is no PATCH. `PUT` is a partial update: every field in the `Update*Dto` schemas is optional.
- **Parameters:** list filters go in the **query string**. The spec declares them `in: query`, which settles the child worker's "JSON body on GET" question. Create/update payloads go in a JSON body.
- **Deletion is soft:** most resources have no DELETE endpoint. You delete by sending `PUT {deleted: true}`. `includeDeleted=true` makes list calls return deleted objects. Real DELETE exists only for `/users/{id}` (removes the user from the company) and `/auth/keys/{key}`.
- **Idempotency:** `idempotencyKey` is accepted on create for tasks, projects, boards and columns. Sending the same key again returns the object that already exists. Use it for MCP retries.
- **Timestamps** are epoch numbers. The spec doesn't state the unit. **UNVERIFIED**, but most likely milliseconds; confirm against a live response.
- **Task fields that replace wholesale:** `checklists` is replaced as a whole, so read, modify, then write. `stickers` is a `{stickerId: stateId}` map. To take a task out of its column, send `columnId: "-"`.

## 4. Pagination

- **Offset paging** (all list endpoints): query params `limit` (default 50, **max 1000**) and `offset` (default 0). The response is `{paging: {count, limit, offset, next: boolean}, content: [...]}`. Keep requesting while `paging.next` is true.
- **Task log** (`GET /tasks/{id}/log`): cursor by time. Params are `limit` (default 50, max 1000) and `before` (the timestamp of the last event on the current page). Response paging is `{count, limit, next}`.
- `GET /webhooks` has no paging params (only `includeDeleted`).

## 5. Endpoint inventory (complete: 41 paths / 70 operations in S1)

Every operation needs bearer auth except the ones under `auth/*`.

| Resource | Operations | List filters (query) |
|---|---|---|
| Auth | `POST auth/companies`, `POST auth/keys/get`, `POST auth/keys`, `DELETE auth/keys/{key}` | limit, offset (companies) |
| Users | `GET users`, `POST users` (invite), `GET users/me`, `GET/PUT/DELETE users/{id}` | email, projectId, limit, offset |
| Company | `GET/PUT companies{*companyId}` (literal path template is odd; in practice `GET /api-v2/companies` for the current company, **UNVERIFIED** live) | — |
| Files | `POST upload-file` (multipart/form-data, field `file`) returns `{result, url, fullUrl}` | — |
| Projects | `GET/POST projects`, `GET/PUT projects/{id}` | includeDeleted, title, limit, offset |
| Project roles | `GET/POST projects/{projectId}/roles`, `GET/PUT/DELETE projects/{projectId}/roles/{id}` | name, limit, offset |
| Departments | `GET/POST departments`, `GET/PUT departments/{id}` | includeDeleted, title, parentId, limit, offset |
| Boards | `GET/POST boards`, `GET/PUT boards/{id}` | includeDeleted, title, projectId, limit, offset |
| Columns | `GET/POST columns`, `GET/PUT columns/{id}` | includeDeleted, title, boardId, limit, offset |
| Tasks | `GET task-list` (preferred), `GET tasks` (reverse order, marked "use /task-list instead"), `POST tasks`, `GET/PUT tasks/{id}`, `GET tasks/{id}/log`, `GET/PUT tasks/{id}/chat-subscribers` | includeDeleted, title, columnId, assignedTo (comma-sep user IDs), stickerId, stickerStateId, limit, offset |
| String stickers | `GET/POST string-stickers`, `GET/PUT string-stickers/{id}`, `POST string-stickers/{stickerId}/states`, `GET/PUT string-stickers/{stickerId}/states/{stickerStateId}` | includeDeleted, name, boardId |
| Sprint stickers | same shape under `sprint-stickers` | includeDeleted, name, boardId |
| Group chats | `GET/POST group-chats`, `GET/PUT group-chats/{id}` | includeDeleted, title |
| Chat messages | `GET/POST chats/{chatId}/messages`, `GET/PUT chats/{chatId}/messages/{id}`, `POST chats/{chatId}/typing` | fromUserId, text, label, since, includeSystem, includeDeleted, limit, offset |
| Webhooks | `POST webhooks`, `GET webhooks`, `PUT webhooks/{id}` | includeDeleted |
| CRM | `POST crm/contact-persons`, `GET crm/contacts/by-external-id?provider&chatId` | — |

A task's chat uses the task ID as its `chatId`. This is **UNVERIFIED**: it is implied by `tasks/{id}/chat-subscribers` but not stated.
**Not in the public API:** delete endpoints for tasks/boards/projects (soft-delete only), a knowledge base, CRM funnels/deals listing, personal chats, reports/summaries, time-entry reports. The claude.ai YouGile connector tools seen in this session (kb_*, crm_list_funnels, summaries) use a different, non-public browser-session channel and **must not** be assumed to exist in REST v2.

## 6. Key request/response shapes (from S1 `components.schemas`)

- **TaskDto**. Required: `id, title, timestamp`. Also: `columnId, description, archived, archivedTimestamp, completed, completedTimestamp, subtasks[], assigned[], createdBy, deadline{deadline, startDate, withTime, history, blockedPoints, links}, timeTracking{plan, work}, checklists[], stickers{}, color (task-primary|task-gray|task-red|…), idTaskCommon, idTaskProject, stopwatch, timer, deal, apiData, extensionData, properties, deleted, type`.
- **CreateTaskDto**. Required: `title`. Plus the same writable fields as TaskDto, and also `deal` (creates a CRM deal) and `idempotencyKey`. **UpdateTaskDto**: all fields optional, plus `deleted`.
- **ProjectDto**: `id, title, timestamp, users{userId: role}, departments{}, deleted`. `role` takes `worker|admin|observer` or a custom role ID. Create requires `title`.
- **BoardDto**: `id, title, projectId, stickers{timer, deadline, stopwatch, timeTracking, assignee, repeat, custom{}}`. Create requires `title, projectId`.
- **ColumnDto**: `id, title, color (number 1–16), boardId`. Create requires `title, boardId`.
- **UserDto**: `id, email, realName, status, lastActivity, isAdmin, messengerOnly, customStatus, hasFakeEmail`.
- **ChatMessageDto**: `id (number; also the creation time), fromUserId, text, textHtml, label, editTimestamp, reactions`. Create requires `text, textHtml, label`, all three according to the spec.
- **Webhook**: create with `{url, event, filters}`. `event` uses the format `<object>-<event>`. Objects: `project, board, column, task, sticker, department, group_chat, chat_message`. Events: `created, deleted, restored, moved, renamed, updated`. `user` only has `added, removed`. The value can be a JS regexp, e.g. `task-*` or `.*`. Filter names are `location` (UUID or UUIDs), `title` (regexp) and `chat_message` (regexp). WebhookDto adds `disabled, lastSuccess, failuresSinceLastSuccess`. **Webhook payload format, signing and retry policy are UNVERIFIED** (not in the spec).

## 7. Errors and rate limits

- Success returns `200`, or `201` on create. Failure returns `3xx/4xx/5xx` with an `error` field describing the problem (S1 text). Every error response in the spec has an **empty description and no schema**. The error body's shape is known only from the vendor's prose, and a NestJS-style `{statusCode, message, error}` body was observed live on a 401 from `/api-v2/swagger-json` during this research.
- Declared codes:
  - `auth/*`: 400/401/403/429
  - most resource ops: 404
  - upload: 400
- **Rate limit:** **50 requests/minute per company** (S1, S4). It is shared by every key and integration in that company. `429` is declared only on the `auth/*` operations. Whether data endpoints also return 429 and send `Retry-After` is **UNVERIFIED**. The MCP should still assume 429 is possible everywhere and rate-limit on the client side (token bucket ≤ ~45/min, backoff on 429/5xx).
- Permission failures follow the key owner's rights. The exact code (403 vs 404) is **UNVERIFIED**.

## 8. API variants

- **v2** (`/api-v2/`) is current. The spec says it is **incompatible with v1**. v1 paths and deprecation status are **UNVERIFIED** (S5 not retrieved), so don't target v1.
- **Cloud vs on-prem:** the API surface is the same and only the host differs (S4). The base URL must be configurable.
- **Webhooks** give push events. An stdio MCP server can't easily receive them, so they're out of scope for v1 of the MCP.

## 9. Recommended MCP coverage (realistic first release)

**Tier 1 (read):** `whoami` (users/me), `list_projects`, `list_boards(projectId)`, `list_columns(boardId)`, `list_tasks(columnId/assignedTo/title/sticker filters, includeDeleted, limit/offset)`, `get_task`, `get_task_log`, `list_users`, `list_stickers` (string + sprint, with states), `list_chat_messages(chatId)`, `list_group_chats`.

**Tier 2 (write, non-destructive):** `create_task` (always send `idempotencyKey`), `update_task` (title/description/column move/assigned/deadline/completed/archived/stickers/checklists, with read-modify-write for checklists), `post_chat_message`, `create_board`, `create_column`, `create_project`.

**Tier 3 (gated / destructive, opt-in flag):** soft-delete via `deleted:true`, user invite/remove, role and department edits, webhook management, file upload.

**Excluded:** `auth/*` login-password flows at runtime, CRM (only 2 endpoints, too thin), and v1.

Cross-cutting design points:
- a single HTTP client with bearer auth and a configurable base URL
- a 50 rpm/company limiter
- auto-pagination capped at a caller-provided max
- compact output projections (TaskDto is large)
- ID resolution helpers: the REST API takes UUIDs only. Human IDs like `DEV-12` map to `idTaskProject`/`idTaskCommon`, but **there is no documented lookup-by-human-ID filter (UNVERIFIED)**

## 10. Open uncertainties

1. Timestamp unit (ms vs s) and timezone. Verify with one live call.
2. Error body schema and 429 behavior/`Retry-After` on non-auth endpoints.
3. Actual request path for `companies{*companyId}`.
4. Webhook delivery payload, signature, and retry semantics.
5. Whether `task-list` supports filtering by board/project directly (only `columnId` is documented).
6. Lookup by human task ID (`DEV-12`).
7. Whether `ChatMessage` create really requires `textHtml` and `label` (they are spec-required, which may be over-strict).
8. v1 status (S5 not retrieved). Key cap: spec says 30 per **account**; child worker reports the news article says per company — follow the spec.
9. The spec has no version pin beyond "v2.0" and the vendor says the API is still being worked on, so re-fetch S1 and diff it against the SHA-256 in the provenance file before implementing.
