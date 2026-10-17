# YouGile REST API v2 — schemas, pagination, filters, errors, limits

Research notes. Retrieval date for all sources: **2026-10-17**.
Scope: official YouGile sources only. Web text treated as untrusted data.
Convention: anything not confirmed from an official page is marked **UNVERIFIED**.

## Coverage status (read this first)

- The official reference `https://ru.yougile.com/api-v2` is a client-rendered (Swagger-style) page. Fetching it returned **only the page title** ("YouGile REST API"). No endpoint list, schemas, or pagination/filter docs could be extracted from it.
- Consequently, request/response shapes for tasks, boards, columns, projects, users, stickers, chats, and webhooks are **UNVERIFIED** in this document.
- The OpenAPI/Swagger JSON was **not** downloaded here (per brief). Its URL was not discovered from the page HTML. Another worker saves the spec into `docs/research/raw/`, which was **empty** at the time of writing. Once the spec is present, the sections below marked UNVERIFIED should be checked against it.

## Sources

| # | URL | Type | Retrieved | Notes |
|---|-----|------|-----------|-------|
| S1 | https://ru.yougile.com/api-v2 | Official API v2 reference | 2026-10-17 | Title only; body not rendered. Anchor links observed in S3: `#/` and `#/operations/AuthKeyController_*` (Swagger-style operation IDs). |
| S2 | https://yougile.com/api-v2 | Official (same host family) | 2026-10-17 | Fetch failed (socket closed). Not usable. |
| S3 | https://ru.yougile.com/api-v2#/ and `#/operations/AuthKeyController_companiesList`, `#/operations/AuthKeyController_create` | Official API v2 reference, anchors | 2026-10-17 | Read via a summarizing fetch; treat as secondhand summary, not raw text. |
| S4 | http://docs.yougile.com/docs/admin-guide-windows/api/ ("Работа с REST API в YouGile") | Official YouGile docs domain | 2026-10-17 | Describes `https://<domain>/api-v2/{resource}`, Bearer auth, 50 req/min, 30 keys. Summarizing fetch. Page is an admin-guide page, not the endpoint reference. |
| S5 | https://ru.yougile.com/news/2022-08-03_api_2.html ("Новая версия REST API") | Official announcement of v2 | 2026-10-17 | Fetch failed (socket closed). **Not verified.** Content of this announcement is unknown here. |
| S6 | https://help.yougile.com/ (knowledge base) | Official help center | 2026-10-17 | Seen in search results only; not fetched. Non-API. |

## Base URL, transport, auth

- Base URL pattern: `https://<domain>/api-v2/{resource}` (S4). Host is the company's main page URL from `mainPageUrl` in `conf.json` (S4). For the cloud service, `https://yougile.com/api-v2/...` appears in a search summary (S5-adjacent, secondhand) — **UNVERIFIED** as the canonical host; `ru.yougile.com/api-v2` is the documented reference page.
- Protocol: HTTPS. HTTP allowed only for local use (S4).
- Auth: `Authorization: Bearer <API key>` on every request (S4).
- API key is generated via the auth-key operations (see below). Keys do not expire (S4).
- Headers: `Content-Type: application/json` (secondhand, S-search; consistent with S4's JSON body statement).

### Auth key endpoints (named in S3; method/path/body **UNVERIFIED**)

- `AuthKeyController_companiesList` — get company IDs for a login.
- `AuthKeyController_create` — generate an API key from login, password, and company ID.
- Listing and deleting keys exists per S4 (operation ID not named).
- Limits: up to **30 keys per account** (S4). Note: one secondhand summary says "per company"; S4 says "per account". Conflict — treat as **UNVERIFIED** until the spec is checked.

## Methods and body format

- Methods used: GET, POST, PUT, DELETE (S4).
- Body: JSON (S4).
- Caution: one secondhand summary states that for "GET" calls parameters are sent as a JSON request body. Sending a JSON body on GET is unusual. **UNVERIFIED** — check the spec before relying on it.

## Success and error responses

- Success: `200 OK` or `201 Created` (S4).
- Failure: status `3xx`, `4xx`, or `5xx` (S4).
- Error body: contains an `error` field with a description (S4). The **schema of the error body beyond `error` is UNVERIFIED** (not described on the fetched page).
- Specific error status codes per endpoint (e.g., 401, 403, 404, 422, 429): **UNVERIFIED**. The 403-style permission behavior is described qualitatively in S4: access follows user permissions, and functions unavailable in the UI are unavailable via the API.

## Rate limits

- **50 requests per minute per company** (S4).
- Behavior on exceeding (e.g., 429 and any Retry-After header): **UNVERIFIED**.

## Pagination

- **Not covered** in any fetched official text (S1, S4). The limit/offset/paging-object shape is **UNVERIFIED**.
- Hint only (not official REST docs): the YouGile MCP tool descriptions in this environment describe a cursor pattern (`cursor` param; first page `null`; continue with `nextCursor` until `null`) for some list tools, and dates as `YYYY-MM-DD hh:mm:ss` local time. This is an MCP-layer description, **not** confirmed for the REST v2 endpoints. Treat as UNVERIFIED for REST.

## Filtering query params

- **UNVERIFIED** for all resources. Nothing about filter parameter names was extracted from official text.

## Resources (request/response shapes)

All **UNVERIFIED** (not extracted from official text):

- Tasks
- Boards
- Columns
- Projects
- Users
- Stickers
- Chats
- Webhooks

Fill these from `docs/research/raw/` once the OpenAPI spec is saved there.

## API variants (v1 vs v2, webhooks)

- Existence of a v2 at `/api-v2/` is confirmed by S1, S3, S4 paths.
- v1 path and deprecation status: **UNVERIFIED**. The S5 announcement title "Новая версия REST API" (2022-08-03) suggests a v2 release, but its content was not retrieved.
- Webhooks in v2: **UNVERIFIED**. No official text retrieved describes webhook endpoints, payloads, or signatures.

## Open items for the next pass

1. Check `docs/research/raw/` for the saved OpenAPI spec and verify every UNVERIFIED item above against it, including exact status codes, error schema, pagination, and filters.
2. Confirm the canonical host (`ru.yougile.com` vs `yougile.com`) and the spec's server URL.
3. Confirm the per-account vs per-company key limit.
4. Confirm whether GET takes query params or a JSON body.
5. Retrieve S5 (v2 announcement) to check v1 vs v2 differences and deprecation dates.
