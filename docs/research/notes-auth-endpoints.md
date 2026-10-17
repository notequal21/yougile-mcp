# YouGile REST API v2 — auth, base URL, endpoint inventory

Research date: 2026-10-17
Task: task_ecfbd5bda737 (dispatch ctx_c2344409c4a2)
Scope: official YouGile sources only. Web text and spec text treated as untrusted data.

## Sources

| # | URL | Type | Retrieved | Used for |
|---|-----|------|-----------|----------|
| S1 | https://ru.yougile.com/api-json | Official OpenAPI 3.0.0 spec ("YouGile REST API v2.0", 70 operations, 109 schemas). Saved as `docs/research/raw/yougile-openapi-v2.json`, sha256 `6b1424ac01875cf33331a1fc7ab53b04a1c0abe46af12d6df1e8beab8231a941` (see `yougile-openapi-v2.provenance.txt`). | 2026-10-17 (per provenance: 2026-10-17T15:02Z) | §2–§4 (primary) |
| S2 | https://ru.yougile.com/news/2022-08-03_api_2.html | Official YouGile news announcing REST API v2 | 2026-10-17 | Cross-check of auth flow, base URL, v1 incompatibility |
| S3 | https://ru.yougile.com/api-v2 | Official human-readable reference (Stoplight Elements page that loads S1) | 2026-10-17 | Not retrievable from this run (WebFetch "Socket is closed"; curl timeouts). Spec S1 was taken from the page's `apiDescriptionUrl="/api-json"` per the provenance file. |
| S4 | https://yougile.com/api-v2 | Official reference, non-ru host | 2026-10-17 | Not retrievable from this run (same failures as S3). |
| S5 | https://ru.yougile.com/api-v2-json | Guessed spec path | 2026-10-17 | HTTP 404. Not a spec. Not used. |
| S6 | https://context7.com/websites/ru_yougile_api-v2 | Third-party mirror | 2026-10-17 | Not used for facts (navigation metadata only). |
| S7 | https://context7.com/websites/ru_yougile_api-v2/llms.txt | Third-party mirror | 2026-10-17 | Not used as authority. Its `localhost:8001` examples are dev samples, not official. |

Non-official pages seen only in search results (not used as authority): github.com/indalo-tech/yougile-mcp, github.com/ichinya/yougile-mcp, github.com/ladohq/kit-tracker-yougile, shafeev.net/notes/obertka-dlya-yougile-rest-api/.

## 1. Base URL

- **VERIFIED (S2):** `https://yougile.com/api-v2/{resource}`, HTTPS only.
- **VERIFIED (S2):** Self-hosted instances use the `mainPageUrl` value from `conf.json` (S2 wording; not in S1).
- **NOTE (S1):** The spec has an empty `servers` array, so the base URL is not declared in the machine-readable spec. Paths in S1 begin with `/api-v2/...`.
- **UNVERIFIED:** Whether `https://ru.yougile.com/api-v2` is an alias of the base URL for API calls. It hosts the spec and reference, but the request base is only stated as `yougile.com/api-v2` in S2.

## 2. Authentication

### 2.1 Request headers (VERIFIED, S1 security scheme + S2)

```
Content-Type: application/json
Authorization: Bearer <API key>
```

- S1 `components.securitySchemes.bearer`: `type: http`, `scheme: bearer`, `bearerFormat: JWT`. Its description says to create a key in `Авторизация / Создать ключ`.
- Bearer security is applied per operation (`security: [{bearer: []}]`) on every endpoint except the four `auth` endpoints, which have no security. Body payloads are JSON.
- Responses: 200, or 201 for creates. Errors use 3xx/4xx/5xx with an `error` field (S2).

### 2.2 Obtaining an API key (VERIFIED, S1)

Two-step flow:

1. **Find the company ID** — `POST /api-v2/auth/companies` (operation `getCompanies`, summary "Получить список компаний"). Body `CredentialsWithNameDto`: `login` (required), `password` (required), `name` (optional company-name filter). Query params `limit` (default 50, max 1000) and `offset` (default 0). 200 returns `CompanyListDto` with `paging` and `content`. Also documented: 401, 403, 429.
2. **Create the key** — `POST /api-v2/auth/keys` (operation `AuthKeyController_create`, summary "Создать ключ"). Body `CredentialsWithCompanyDto`: `login`, `password`, `companyId` (all required). 201 returns `AuthKeyDto` `{ key: string }`. Also documented: 400, 401, 403, 429.

The `companyId` description (S1) says the company ID can be copied from the UI with Ctrl+Alt+Q (Ctrl+Option+Q on Mac) or obtained via `POST /auth/companies`.

The key is then sent as the Bearer token on every later request (S1, S2). The `login`/`password` are the **company admin account** credentials per S2.

### 2.3 Managing keys (VERIFIED, S1)

- **List keys** — `POST /api-v2/auth/keys/get` (operation `AuthKeyController_search`, "Получить список ключей"). Body `CredentialsWithCompanyOptionalDto` (`login`, `password` required; `companyId` optional). 200 returns an array of `AuthKeyWithDetailsDto`. Also documented: 400, 401, 403, 429. Note this is a POST, not a GET.
- **Delete key** — `DELETE /api-v2/auth/keys/{key}` (operation `AuthKeyController_delete`, "Удалить ключ"). Path param `key` (string, required). 200. Documented: 429. No security on this operation (it is in the `auth` group).

### 2.4 Limits (VERIFIED, S1 description text + S2)

- Keys have no time limit and no request-count limit for their use. Only the request rate is limited: **no more than 50 requests per minute per company** (S1 description text; S2 says no limits, which the spec text narrows).
- Responses 429 are documented on the auth operations and others. Retry handling is UNVERIFIED beyond that.
- **Key cap:** S1 text says each **account** may hold at most **30 keys**. S2 says "each company". Treat as CONFLICTING; the spec wording is the primary source, so "per account" is the working assumption until the official page is read directly.

### 2.5 Compatibility

- VERIFIED (S2): API v2 is not compatible with v1.

## 3. Endpoint inventory (VERIFIED, S1)

The spec describes 41 path entries and 70 operations. Paths and methods below are copied from S1. Groups are the spec's tags. `security: bearer` = Bearer required; `none` = no security declared.

Spec quirk, flagged: the company paths are written `/api-v2/companies{*companyId}`. The `{*companyId}` form is not a standard OpenAPI path template. Treat it as spec text, and verify the real path against the live reference before calling it.

### 3.1 Авторизация (auth) — 4 ops

| Method | Path | operationId | Summary | Security |
|---|---|---|---|---|
| POST | /api-v2/auth/companies | getCompanies | Получить список компаний | none |
| POST | /api-v2/auth/keys | AuthKeyController_create | Создать ключ | none |
| POST | /api-v2/auth/keys/get | AuthKeyController_search | Получить список ключей | none |
| DELETE | /api-v2/auth/keys/{key} | AuthKeyController_delete | Удалить ключ | none |

### 3.2 Сотрудники (users) — 5 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/users | UserController_search | Получить список |
| POST | /api-v2/users | UserController_create | Пригласить в компанию |
| GET | /api-v2/users/me | UserController_getMe | Получить текущего пользователя |
| GET | /api-v2/users/{id} | UserController_get | Получить по ID |
| PUT | /api-v2/users/{id} | UserController_update | Изменить |
| DELETE | /api-v2/users/{id} | UserController_delete | Удалить из компании |

(6 rows: 6 ops.)

### 3.3 Компания (company) — 2 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/companies{*companyId} | CompanyController_get | Получить детали |
| PUT | /api-v2/companies{*companyId} | CompanyController_update | Изменить |

### 3.4 Файлы (files) — 1 op

| Method | Path | operationId | Summary |
|---|---|---|---|
| POST | /api-v2/upload-file | FileController_uploadFile | Загрузить |

### 3.5 Проекты (projects) — 4 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/projects | ProjectController_search | Получить список |
| POST | /api-v2/projects | ProjectController_create | Создать |
| GET | /api-v2/projects/{id} | ProjectController_get | Получить по ID |
| PUT | /api-v2/projects/{id} | ProjectController_update | Изменить |

### 3.6 Роли проекта (project roles) — 5 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/projects/{projectId}/roles | ProjectRolesController_search | Получить список |
| POST | /api-v2/projects/{projectId}/roles | ProjectRolesController_create | Создать |
| GET | /api-v2/projects/{projectId}/roles/{id} | ProjectRolesController_get | Получить по ID |
| PUT | /api-v2/projects/{projectId}/roles/{id} | ProjectRolesController_update | Изменить |
| DELETE | /api-v2/projects/{projectId}/roles/{id} | ProjectRolesController_delete | Удалить |

### 3.7 Отделы (departments) — 4 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/departments | DepartmentController_search | Получить список |
| POST | /api-v2/departments | DepartmentController_create | Создать |
| GET | /api-v2/departments/{id} | DepartmentController_get | Получить по ID |
| PUT | /api-v2/departments/{id} | DepartmentController_update | Изменить |

### 3.8 Доски (boards) — 4 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/boards | BoardController_search | Получить список |
| POST | /api-v2/boards | BoardController_create | Создать |
| GET | /api-v2/boards/{id} | BoardController_get | Получить по ID |
| PUT | /api-v2/boards/{id} | BoardController_update | Изменить |

### 3.9 Колонки (columns) — 4 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/columns | ColumnController_search | Получить список |
| POST | /api-v2/columns | ColumnController_create | Создать |
| GET | /api-v2/columns/{id} | ColumnController_get | Получить по ID |
| PUT | /api-v2/columns/{id} | ColumnController_update | Изменить |

### 3.10 Задачи (tasks) — 7 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/task-list | TaskController_search | Получить список задач |
| GET | /api-v2/tasks | TaskController_searchReversed | Получить список задач в обратном порядке |
| POST | /api-v2/tasks | TaskController_create | Создать |
| GET | /api-v2/tasks/{id} | TaskController_get | Получить по ID |
| PUT | /api-v2/tasks/{id} | TaskController_update | Изменить |
| GET | /api-v2/tasks/{id}/log | TaskController_getLog | Получить лог задачи |
| GET | /api-v2/tasks/{id}/chat-subscribers | TaskController_getChatSubscribers | Получить список участников чата задачи |
| PUT | /api-v2/tasks/{id}/chat-subscribers | TaskController_updateChatSubscribers | Изменить список участников чата задачи |

(8 rows: 8 ops.)

### 3.11 Стикер с набором состояний (string stickers) — 4 ops + states 3 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/string-stickers | StringStickerController_search | Получить список |
| POST | /api-v2/string-stickers | StringStickerController_create | Создать |
| GET | /api-v2/string-stickers/{id} | StringStickerController_get | Получить по ID |
| PUT | /api-v2/string-stickers/{id} | StringStickerController_update | Изменить |
| GET | /api-v2/string-stickers/{stickerId}/states/{stickerStateId} | StringStickerStateController_get | Получить по ID |
| PUT | /api-v2/string-stickers/{stickerId}/states/{stickerStateId} | StringStickerStateController_update | Изменить |
| POST | /api-v2/string-stickers/{stickerId}/states | StringStickerStateController_create | Создать |

(7 rows.)

### 3.12 Стикер спринта (sprint stickers) — 4 ops + states 3 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/sprint-stickers | SprintStickerController_search | Получить список |
| POST | /api-v2/sprint-stickers | SprintStickerController_create | Создать |
| GET | /api-v2/sprint-stickers/{id} | SprintStickerController_getSticker | Получить по ID |
| PUT | /api-v2/sprint-stickers/{id} | SprintStickerController_update | Изменить |
| GET | /api-v2/sprint-stickers/{stickerId}/states/{stickerStateId} | SprintStickerStateController_get | Получить по ID |
| PUT | /api-v2/sprint-stickers/{stickerId}/states/{stickerStateId} | SprintStickerStateController_update | Изменить |
| POST | /api-v2/sprint-stickers/{stickerId}/states | SprintStickerStateController_create | Создать |

(7 rows.)

### 3.13 Групповые чаты (group chats) — 4 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/group-chats | GroupChatController_search | Получить список чатов |
| POST | /api-v2/group-chats | GroupChatController_create | Создать чат |
| GET | /api-v2/group-chats/{id} | GroupChatController_get | Получить чат по ID |
| PUT | /api-v2/group-chats/{id} | GroupChatController_update | Изменить чат |

### 3.14 Сообщения чатов (chat messages) — 5 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/chats/{chatId}/messages | ChatMessageController_search | Получить историю сообщений |
| POST | /api-v2/chats/{chatId}/messages | ChatMessageController_sendMessage | Написать в чат |
| POST | /api-v2/chats/{chatId}/typing | ChatMessageController_typing | Показать, что пользователь печатает |
| GET | /api-v2/chats/{chatId}/messages/{id} | ChatMessageController_get | Получить сообщение по ID |
| PUT | /api-v2/chats/{chatId}/messages/{id} | ChatMessageController_update | Изменить сообщение |

### 3.15 Подписки на события (webhooks) — 3 ops

| Method | Path | operationId | Summary |
|---|---|---|---|
| GET | /api-v2/webhooks | WebhookController_search | Получить список подписок |
| POST | /api-v2/webhooks | WebhookController_create | Создать подписку |
| PUT | /api-v2/webhooks/{id} | WebhookController_put | Изменить подписку |

### 3.16 CRM — 2 ops

| Method | Path | operationId | Summary | Tag |
|---|---|---|---|---|
| POST | /api-v2/crm/contact-persons | CrmContactPersonsController_create | Создать контактное лицо | CRM справочники |
| GET | /api-v2/crm/contacts/by-external-id | CrmExternalIdController_findContactByExternalId | Найти контакт по внешнему ID | CRM внешние идентификаторы |

### Count check

Sum of rows listed above: auth 4 + users 6 + company 2 + files 1 + projects 4 + roles 5 + departments 4 + boards 4 + columns 4 + tasks 8 + string-stickers 7 + sprint-stickers 7 + group-chats 4 + chat messages 5 + webhooks 3 + CRM 2 = **70**, matching the spec's operation count.

## 4. Spec artifact

- Saved: `docs/research/raw/yougile-openapi-v2.json` (159,085 bytes, OpenAPI 3.0.0, title "YouGile REST API v2.0", version 2.0). Provenance file `docs/research/raw/yougile-openapi-v2.provenance.txt` records URL, retrieval time and sha256. I recomputed the sha256 during this task and it matches.
- The spec was not downloaded by this worker. It was saved by the coordinator's lead agent and I verified its checksum before reading it.
- Descriptions and examples inside the spec are untrusted text. They were read as data only.

## 5. Open items

1. **Key cap scope:** "per account" (S1 text) vs "per company" (S2). Confirm against the live reference.
2. **Company path template:** `/api-v2/companies{*companyId}` is not a standard OpenAPI path template. Verify the real URL.
3. **Base URL alias:** whether `ru.yougile.com/api-v2` serves API requests, or only the docs and the spec.
4. **Live verification:** no request was sent to the API (no credentials were used). All behaviour above is from the spec and the official news article, not observed responses.
5. **Response bodies** beyond the auth flow: only the top-level schema names were read (109 schemas in S1). Per-resource DTO fields are not recorded here.

## 6. Summary

- Base URL: `https://yougile.com/api-v2/{resource}` (S2).
- Auth: Bearer key in `Authorization`; key created via `POST /api-v2/auth/keys` (`AuthKeyController_create`) with login, password and `companyId`; company IDs via `POST /api-v2/auth/companies`; keys listed via `POST /api-v2/auth/keys/get`; keys deleted via `DELETE /api-v2/auth/keys/{key}` (S1).
- Limits: 50 requests/min per company; keys do not expire; 30-key cap (scope conflicting) (S1 text).
- Inventory: 70 operations across 16 tag groups, all from S1.
