# YouGile MCP Server — Architecture

Status: **design approved for implementation** (architecture lead, 2026-10-17).
Inputs: [`research/YOUGILE_API.md`](research/YOUGILE_API.md) and the vendor OpenAPI spec saved at
[`research/raw/yougile-openapi-v2.json`](research/raw/yougile-openapi-v2.json) (41 paths, 70 operations).
Every endpoint below is in that spec. If a tool is not in this document, it must not be implemented. There is
**no** generic "call any HTTP path" tool.

## 1. Goals and non-goals

Goals
- A local **stdio** MCP server that lets an LLM client read and edit a YouGile company: projects, boards, columns,
  tasks, stickers, chats, users, departments, roles and webhooks. It works with YouGile cloud and with on-prem installs.
- Broad CRUD coverage of what REST v2 actually supports. Writes must be safe by default.
- The server must be predictable under the vendor's **50 req/min per company** limit.

Non-goals (v1)
- Runtime login with a password. The server **never** receives, stores or asks for an account password. The `auth/*`
  endpoints are out of scope for the runtime, and key creation is documented in the README as a one-time manual `curl` step.
- Receiving webhooks. stdio has no inbound HTTP. Webhook *management* is in scope.
- REST v1, knowledge base, CRM funnels/deals, personal chats and reports. These are not in the public REST v2.
- `POST /chats/{chatId}/typing` (no value for an agent), `GET /tasks` (deprecated in favour of `/task-list`),
  `crm/*` (only 2 thin endpoints; may be added later behind the write gate), and `PUT /companies` (company
  rename/delete is too dangerous to be worth having).
- File upload (`POST /upload-file`, multipart) is **deferred to v1.1**. The reason: it needs local filesystem reads, which
  widen the trust surface. The design leaves a slot for it (§6.10).

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js **>= 20** (dev on 24), ESM | Has native `fetch`/`AbortSignal.timeout`. Matches the official SDK. |
| Language | TypeScript 5.x, `strict`, `noUncheckedIndexedAccess` | |
| MCP | `@modelcontextprotocol/sdk` (latest 1.x), `McpServer` + `StdioServerTransport`, `registerTool` with zod shapes | This is the official SDK. |
| Validation | `zod` (the version the SDK peer-depends on, 3.x) | Gives tool input schemas and one source of truth for env config. |
| HTTP | built-in `fetch` (undici). No axios. | Fewer dependencies. |
| Tests | `vitest`, with an in-process fake fetch. No network in CI. | |
| Lint/format | `eslint` (typescript-eslint flat config) + `prettier` | |
| Build | `tsc` to `dist/`. The bin is `dist/index.js` with a shebang. | No bundler is needed. |
| Package manager | npm, with `package-lock.json` committed | |

## 3. Configuration (environment only)

All variables are parsed once at startup in `src/config.ts` with zod. If any is invalid, the server exits with code 2 and prints
one sanitized line to **stderr**. It never prints the key.

| Var | Required | Default | Meaning |
|---|---|---|---|
| `YOUGILE_API_KEY` | yes | — | Bearer key, issued beforehand (README explains `POST /auth/keys`). |
| `YOUGILE_BASE_URL` | no | `https://yougile.com` | Origin only. The client appends `/api-v2`. For on-prem, use your own origin. Must be `https:`, except `http://localhost` / `127.0.0.1`. |
| `YOUGILE_ALLOW_WRITES` | no | `false` | If not `true`, **no mutating tools are registered**. The server is read-only. |
| `YOUGILE_ALLOW_DESTRUCTIVE` | no | `false` | Registers the soft-delete tools and the user remove / role delete tools (see §7). Requires `ALLOW_WRITES=true`. |
| `YOUGILE_RATE_LIMIT_PER_MIN` | no | `40` | Client-side budget. Range 1–50. Leaves headroom for other integrations in the company. |
| `YOUGILE_TIMEOUT_MS` | no | `15000` | Per-attempt HTTP timeout. Range 1000–60000. |
| `YOUGILE_MAX_ITEMS` | no | `500` | Hard cap on items that one auto-paginating tool call may return. Range 1–5000. |
| `YOUGILE_LOG_LEVEL` | no | `info` | `error`/`warn`/`info`/`debug`. Logs go to stderr only. stdout carries only the MCP protocol. |

stdout is reserved for JSON-RPC. Any `console.log` in `src/` is a lint error (`no-console` with only `error`/`warn` allowed, both of which go to stderr).

Client configuration example (it goes in the README):
```json
{ "mcpServers": { "yougile": {
  "command": "node", "args": ["/abs/path/yougile-mcp/dist/index.js"],
  "env": { "YOUGILE_API_KEY": "…", "YOUGILE_ALLOW_WRITES": "true" } } } }
```
The canonical launch is the local absolute `dist/index.js` path. The package is **not published**, so `npx yougile-mcp` will not work until it is.

## 4. Module layout and interfaces

```
src/
  index.ts              # entry: loadConfig → createServer → connect StdioServerTransport; SIGINT/SIGTERM close
  config.ts             # zod env schema → Config (frozen)
  server.ts             # createServer(config, deps?) → McpServer; registers tool groups per gates
  http/
    client.ts           # YouGileClient: request(), get(), post(), put(), del(), paginate()
    rateLimiter.ts      # RateLimiter (token bucket, FIFO queue)
    retry.ts            # retry policy helpers (isRetryable, backoff)
    errors.ts           # YouGileError + toToolError() sanitizer
  tools/
    _shared.ts          # zod primitives (Id, Limit, Offset…), result helpers, defineTool()
    users.ts  company.ts projects.ts roles.ts departments.ts boards.ts columns.ts
    tasks.ts  stickers.ts chats.ts webhooks.ts
  format/
    project.ts          # compact projections (taskSummary(), taskDetail(), …)
test/
  helpers/fakeFetch.ts  # scripted fetch responses + call recorder
  unit/…  tools/…
```

### 4.1 Key interfaces (implementers must follow these signatures)

```ts
// config.ts
export interface Config { apiKey: string; baseUrl: string; allowWrites: boolean; allowDestructive: boolean;
  rateLimitPerMin: number; timeoutMs: number; maxItems: number; logLevel: 'error'|'warn'|'info'|'debug'; }
export function loadConfig(env?: NodeJS.ProcessEnv): Config;      // throws ConfigError(message w/o secrets)

// http/client.ts
export type Method = 'GET'|'POST'|'PUT'|'DELETE';
export interface RequestOptions { query?: Record<string, string|number|boolean|undefined>; body?: unknown;
  idempotent?: boolean /* default: method==='GET' */; signal?: AbortSignal; }
export interface Page<T> { items: T[]; count?: number; nextOffset: number|null; truncated: boolean; }
export class YouGileClient {
  constructor(cfg: Pick<Config,'apiKey'|'baseUrl'|'timeoutMs'>, limiter: RateLimiter, fetchImpl?: typeof fetch);
  request<T>(method: Method, path: string, opts?: RequestOptions): Promise<T>;  // path like '/tasks/abc'
  // offset paging: walks paging.next, page size = min(remaining,1000), stops at maxItems
  paginate<T>(path: string, query: Record<string,unknown>, opts: { offset: number; maxItems: number }): Promise<Page<T>>;
}
// http/rateLimiter.ts
export class RateLimiter { constructor(perMinute: number, now?: () => number);
  acquire(signal?: AbortSignal): Promise<void>;  penalize(ms: number): void; /* on 429 */ }
// http/errors.ts
export class YouGileError extends Error { status: number|null; code: ErrorCode; retryable: boolean; }
export type ErrorCode = 'auth'|'forbidden'|'not_found'|'validation'|'rate_limited'|'timeout'|'network'|'server'|'unknown';
export function toToolError(e: unknown): { isError: true; content: [{type:'text'; text: string}] };
// tools/_shared.ts
export interface ToolDeps { client: YouGileClient; config: Config; }
export type ToolGroup = (server: McpServer, deps: ToolDeps) => void;
```

Each `tools/*.ts` exports `registerXxxTools: ToolGroup`. Inside, it registers read tools always, and write and destructive
tools only when `deps.config.allowWrites` or `deps.config.allowDestructive` is set. `server.ts` just calls every group.

## 5. Cross-cutting behaviour

### 5.1 Rate limiting (per company)
One API key maps to exactly one company, so a single process-wide `RateLimiter` **is** the per-company limiter. It is a
token bucket with capacity `ceil(perMin/4)` (burst), refilled continuously at `perMin/60000` tokens/ms, and a FIFO
queue of waiters. Every HTTP attempt, including retries, calls `acquire()` first. On a `429`, call
`penalize(min(retryAfterMs ?? 60000/perMin*4, 60000))`, which drains the bucket and pauses refills for that long. A waiter whose
`signal` aborts is removed from the queue and rejects with `timeout`. The waiting time is bounded by the tool's overall deadline (§5.2).

### 5.2 Timeouts
- Per attempt: `AbortSignal.timeout(cfg.timeoutMs)`, combined with the caller's signal (MCP `extra.signal`, which fires on
  client cancel) via `AbortSignal.any`.
- Per tool call: an overall deadline of `max(60s, 4*timeoutMs)`, which covers limiter waits, retries and pagination. When it
  passes, the call fails with `timeout`. For a paginated read it instead returns the partial results with `truncated: true` and the next offset.

### 5.3 Retries
| Request | Retry on | Policy |
|---|---|---|
| `GET` (idempotent) | network error, timeout, 429, 502/503/504 | up to 3 attempts. Backoff 500ms·2^n with full jitter, capped at 8s. Honour `Retry-After` (seconds or HTTP date) if present. |
| `POST` create **with `idempotencyKey`** (tasks, projects, boards, columns) | same as GET | The server generates one UUID per tool call and reuses it on every retry, so the vendor deduplicates. |
| `PUT` | 429 only (the request was rejected before it was processed) | up to 2 attempts. A timeout or 5xx is **not** retried. Instead, return error code `unknown_outcome` advising a re-read. PUT fields here are absolute values, but checklist and subtask replacement makes blind retries risky after a read-modify-write. |
| `POST` without idempotency (messages, stickers, states, departments, roles, users invite, webhooks, group chats), `DELETE` | 429 only | Same as PUT. Never retried after the request may have reached the server. |

For non-idempotent calls, `ErrorCode` gains an extra value: `'unknown_outcome'`.

### 5.4 Errors (sanitized)
`toToolError` returns an MCP tool result with `isError: true` and one line of text:
`YouGile <code> (HTTP <status>): <message>` plus a hint for the code (auth → "check YOUGILE_API_KEY"; forbidden →
"key owner lacks permission"; not_found → "check the id; it may be deleted (try includeDeleted)").
`message` is taken from the response body's `error` or `message` field if it is a string (or an array of strings, joined), truncated to
300 chars. Otherwise the HTTP status text is used. **Never** include: the Authorization header, the API key (the key value is also
scrubbed by string replace as a defence-in-depth step), full URLs with query strings, stack traces, or raw HTML bodies.
Status mapping: 400/422 → validation, 401 → auth, 403 → forbidden, 404 → not_found, 429 → rate_limited, 5xx → server.
Unexpected exceptions are logged to stderr at `debug` with the stack, and returned to the model as `unknown` with a generic message.
Zod input failures are handled by the SDK.

### 5.5 Pagination
- List tools take `limit` (1–1000, default 50) and `offset` (>=0, default 0). They perform **one** request and return
  `{ items, paging: { count, limit, offset, next, nextOffset } }`, where `nextOffset = offset+items.length` if `next`, else `null`.
- Tools whose name ends in `_all` do not exist. Instead, read tools that filter (`list_tasks`) accept `fetchAll: boolean`
  (default false). When it is true, the client walks the pages up to `min(maxItems arg, YOUGILE_MAX_ITEMS)` and sets `truncated` when it stops early.
- Task log uses a cursor: `limit` plus `before` (a timestamp). The output has `nextBefore` = the timestamp of the last item when `next` is true.
- Webhooks: the endpoint has no paging, so the full list is returned (it is small by nature).

### 5.6 Output shape
Every tool returns `content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]` and `structuredContent: result`.
`outputSchema` is declared only where it is cheap. It is optional for v1.
List results use **compact projections** (see `format/project.ts`), because TaskDto is large:
- task summary: `id, title, idTaskProject?, columnId, completed, archived, deleted?, assigned, deadline?.deadline, color, timestamp`.
- `get_task` returns the full DTO.
- Timestamps are passed through as numbers, and an ISO string is added for convenience on `timestamp`, `deadline` and `completedTimestamp`
  (field `<name>Iso`). The spec examples (`1653029146646`) indicate **milliseconds**. Inputs for deadlines accept either an epoch ms number
  or an ISO-8601 string, which `_shared.ts` converts (`EpochMs` zod preprocess).

### 5.7 Tool annotations
Every tool sets `annotations`: read tools `{readOnlyHint:true, openWorldHint:true}`; create tools `{readOnlyHint:false,
destructiveHint:false, idempotentHint:false}`; update tools `{destructiveHint:false, idempotentHint:true}`
(checklist/subtask replacement: `destructiveHint:true`); soft-delete/remove tools `{destructiveHint:true}`.

## 6. MCP tool catalogue (exact schemas)

Notation: `Id` = `z.string().min(1).max(100)` (YouGile ids are UUIDs, but sticker state ids are 12-hex. So use no strict
UUID regex). `Limit` = int 1..1000 default 50. `Offset` = int >=0 default 0. `IncDel` = `includeDeleted: boolean default false`.
Fields marked `?` are optional. **R** = read (always registered), **W** = needs ALLOW_WRITES, **D** = needs ALLOW_DESTRUCTIVE.
"→" gives the HTTP mapping. Unless stated otherwise, input field names equal the API field names, so they are passed through.

### 6.1 Account / users
| Tool | Gate | Input | → |
|---|---|---|---|
| `yougile_whoami` | R | `{}` | `GET /users/me` |
| `yougile_get_company` | R | `{}` | `GET /companies` (see §10 risk 1) |
| `yougile_list_users` | R | `{ email?: string, projectId?: Id, limit, offset }` | `GET /users` |
| `yougile_get_user` | R | `{ id: Id }` | `GET /users/{id}` |
| `yougile_invite_user` | W | `{ email: string.email(), isAdmin?: boolean, messengerOnly?: boolean }` | `POST /users` |
| `yougile_update_user` | W | `{ id, isAdmin?: boolean, messengerOnly?: boolean }` (at least 1 field) | `PUT /users/{id}` |
| `yougile_remove_user` | D | `{ id: Id, confirm: z.literal(true) }` | `DELETE /users/{id}` |

### 6.2 Projects and roles
| Tool | Gate | Input | → |
|---|---|---|---|
| `yougile_list_projects` | R | `{ title?: string, includeDeleted?, limit, offset }` | `GET /projects` |
| `yougile_get_project` | R | `{ id }` | `GET /projects/{id}` |
| `yougile_create_project` | W | `{ title: string.min(1), users?: Record<Id, string /* worker\|admin\|observer\|roleId */>, departments?: Record<Id,string> }` (spec `CreateProjectDto` also has `departments`) | `POST /projects` + idempotencyKey |
| `yougile_update_project` | W | `{ id, title?, users?: Record<Id,string>, departments?: Record<Id,string> }` (at least 1; `departments` per spec `UpdateProjectDto`). Note in the description: `users` **replaces** membership. | `PUT /projects/{id}` |
| `yougile_list_project_roles` | R | `{ projectId, name?, limit, offset }` | `GET /projects/{projectId}/roles` |
| `yougile_get_project_role` | R | `{ projectId, id }` | `GET …/roles/{id}` |
| `yougile_create_project_role` | W | `{ projectId, name, description?, permissions: z.record(z.unknown()) }` (shape = `ProjectPermissionsDto`; the tool description points to `get_project_role` output as a template) | `POST …/roles` |
| `yougile_update_project_role` | W | `{ projectId, id, name?, description?, permissions? }` | `PUT …/roles/{id}` |
| `yougile_delete_project_role` | D | `{ projectId, id, confirm: true }` | `DELETE …/roles/{id}` |

### 6.3 Departments
| `yougile_list_departments` | R | `{ title?, parentId?, includeDeleted?, limit, offset }` | `GET /departments` |
|---|---|---|---|
| `yougile_get_department` | R | `{ id }` | `GET /departments/{id}` |
| `yougile_create_department` | W | `{ title, parentId?: Id, users?: Record<Id,string> }` | `POST /departments` |
| `yougile_update_department` | W | `{ id, title?, parentId?, users? }` | `PUT /departments/{id}` |

### 6.4 Boards and columns
| `yougile_list_boards` | R | `{ projectId?, title?, includeDeleted?, limit, offset }` | `GET /boards` |
|---|---|---|---|
| `yougile_get_board` | R | `{ id }` | `GET /boards/{id}` |
| `yougile_create_board` | W | `{ title, projectId, stickers?: { timer?, deadline?, stopwatch?, timeTracking?, assignee?, repeat?: boolean, custom?: Record<Id, boolean> } }` | `POST /boards` + idempotencyKey |
| `yougile_update_board` | W | `{ id, title?, projectId? /* move */, stickers? }` | `PUT /boards/{id}` |
| `yougile_list_columns` | R | `{ boardId?, title?, includeDeleted?, limit, offset }` | `GET /columns` |
| `yougile_get_column` | R | `{ id }` | `GET /columns/{id}` |
| `yougile_create_column` | W | `{ title, boardId, color?: int 1..16 }` | `POST /columns` + idempotencyKey |
| `yougile_update_column` | W | `{ id, title?, color?, boardId? }` | `PUT /columns/{id}` |

### 6.5 Tasks
```ts
// Spec `Deadline` requires `deadline`, `blockedPoints` and `links`; `UpdateDeadline` makes everything optional.
const Deadline = z.object({ deadline: EpochMs, startDate: EpochMs.optional(), withTime: z.boolean().optional() }); // create; update accepts every key optional and merges with the stored sticker
// Spec `TimeTracking` requires both `plan` and `work`. The tool accepts either and fills the missing one (0 on create, the stored value on update).
const TimeTracking = z.object({ plan: z.number().min(0).optional(), work: z.number().min(0).optional() }); // hours
const Checklist = z.object({ title: z.string(), items: z.array(z.object({ title: z.string(), isCompleted: z.boolean().default(false) })) });
const TaskColor = z.enum(['task-primary','task-gray','task-red','task-pink','task-yellow','task-green','task-turquoise','task-blue','task-violet']);
const Stickers = z.record(Id, z.union([z.string(), z.array(z.string())])); // stateId | "-" | "empty" | free text | stateId[]
```
| Tool | Gate | Input | → |
|---|---|---|---|
| `yougile_list_tasks` | R | `{ columnId?, assignedTo?: Id[] (joined by ","), title?, stickerId?, stickerStateId?, includeDeleted?, limit, offset, fetchAll?: boolean, maxItems?: int }` | `GET /task-list` |
| `yougile_get_task` | R | `{ id }` | `GET /tasks/{id}` |
| `yougile_get_task_log` | R | `{ id, limit, before?: number }` | `GET /tasks/{id}/log` |
| `yougile_get_task_chat_subscribers` | R | `{ id }` | `GET /tasks/{id}/chat-subscribers` |
| `yougile_create_task` | W | `{ title, columnId?, description?, assigned?: Id[], deadline?: Deadline, timeTracking?, checklists?: Checklist[], stickers?, color?, subtasks?: Id[], completed?, archived? }` | `POST /tasks` + idempotencyKey. `deadline.deadline` is required on create (the spec's `Deadline` requires it, so a start-date-only deadline cannot be created); the tool adds `blockedPoints: [], links: []` (spec-required). `timeTracking` is sent with both `plan` and `work`, a missing one defaulting to `0`. |
| `yougile_update_task` | W | `{ id, title?, description?, columnId?: Id \| "-" , assigned?: Id[], deadline?: Deadline \| null /* null → {deleted:true, blockedPoints:[], links:[]} */, timeTracking?: TimeTracking \| null /* null → {deleted:true} */, stickers?, color?, completed?, archived? }` (at least 1 field). A partial `deadline`/`timeTracking` is merged with the stored value (the task is read first; existing `blockedPoints` and `links` are preserved) so the spec-required keys are always sent. | `PUT /tasks/{id}` (preceded by `GET /tasks/{id}` for partial `deadline`/`timeTracking`) |
| `yougile_move_task` | W | `{ id, columnId: Id }` | `PUT /tasks/{id}` (a convenience wrapper; clearer for models) |
| `yougile_set_task_checklists` | W | `{ id, checklists: Checklist[], mode: 'replace' \| 'append' (default 'append') }`. `append` performs a GET and then a PUT of existing+new. | `GET`+`PUT /tasks/{id}` |
| `yougile_set_task_subtasks` | W | `{ id, subtasks: Id[], mode: 'replace'\|'add'\|'remove' (default 'add') }`, read-modify-write | `GET`+`PUT /tasks/{id}` |
| `yougile_set_task_chat_subscribers` | W | `{ id, users: Id[] }` (replaces) | `PUT /tasks/{id}/chat-subscribers` (body `TaskChatSubscribersDto` = `{ content: Id[] }`) |
| `yougile_delete_task` | D | `{ id, confirm: true }` | `PUT /tasks/{id} {deleted:true}` |
| `yougile_restore` (generic restore) | W | `{ kind: 'task'\|'board'\|'column'\|'project'\|'department'\|'group_chat'\|'string_sticker'\|'sprint_sticker', id }` | `PUT /<kind path>/{id} {deleted:false}` (restoring is not destructive) |

Read-modify-write tools must re-read the task immediately before the PUT. They return the final value that was written.
They accept no `expectedTimestamp`, because the API has no conditional update. Their description warns about races.
Timer and stopwatch fields are not exposed in v1, because they are low value and their state semantics are unclear.
`deal`, `apiData` and `extensionData` are not exposed either.

### 6.6 Stickers (string + sprint)
`kind: z.enum(['string','sprint'])` selects `/string-stickers` or `/sprint-stickers`.
| `yougile_list_stickers` | R | `{ kind, boardId?, name?, includeDeleted?, limit, offset }` | `GET /<kind>-stickers` (the response includes states) |
|---|---|---|---|
| `yougile_get_sticker` | R | `{ kind, id }` | `GET /<kind>-stickers/{id}` |
| `yougile_create_sticker` | W | string: `{ kind:'string', name, icon?, states?: {name, color?}[] }`; sprint: `{ kind:'sprint', name, states?: {name, begin?: EpochMs, end?: EpochMs}[] }` (discriminated union) | `POST /<kind>-stickers` |
| `yougile_update_sticker` | W | `{ kind, id, name?, icon? (string only) }` | `PUT /<kind>-stickers/{id}` |
| `yougile_create_sticker_state` | W | `{ kind, stickerId, name, color? (string), begin?/end? (sprint) }` | `POST /<kind>-stickers/{stickerId}/states` |
| `yougile_update_sticker_state` | W | `{ kind, stickerId, stateId, name?, color?, begin?, end? }` | `PUT …/states/{stateId}` |
| `yougile_delete_sticker` | D | `{ kind, id, confirm:true }` / state variant `{ kind, stickerId, stateId, confirm:true }` as `yougile_delete_sticker_state` | `PUT … {deleted:true}` |

The spec has no endpoint that lists *all* sticker types attached to a board other than these two. Do not invent one.

### 6.7 Chats
| `yougile_list_group_chats` | R | `{ title?, includeDeleted?, limit, offset }` | `GET /group-chats` |
|---|---|---|---|
| `yougile_get_group_chat` | R | `{ id }` | `GET /group-chats/{id}` |
| `yougile_create_group_chat` | W | `{ title, users: Record<Id, { notified: boolean }>, userRoleMap?: Record<Id, string /* spec example: owner, admin */>, roleConfigMap?: Record<string, {editProperties,editAdmins,editUsers,sendMessages,removeMessages: boolean}> }`. Spec `CreateGroupChatDto` requires all four keys; if the two maps are omitted the tool sends `{}`. The minimal body the live API accepts is unverified. | `POST /group-chats` |
| `yougile_update_group_chat` | W | `{ id, title?, users?, userRoleMap?, roleConfigMap? }` (spec `UpdateGroupChatDto`, all optional; at least 1). `users`, `userRoleMap` and `roleConfigMap` replace the stored maps, so pass the full value. | `PUT /group-chats/{id}` |
| `yougile_list_messages` | R | `{ chatId /* group chat id or task id */, fromUserId?, text?, label?, since?: EpochMs, includeSystem?: boolean, includeDeleted?, limit, offset }` | `GET /chats/{chatId}/messages` |
| `yougile_get_message` | R | `{ chatId, id: number\|string }` | `GET /chats/{chatId}/messages/{id}` |
| `yougile_send_message` | W | `{ chatId, text: string.min(1).max(10000), textHtml?: string, label?: string }`. Defaults: `textHtml` = HTML-escaped text with `\n`→`<br>`, `label` = `""`. | `POST /chats/{chatId}/messages` |
| `yougile_update_message` | W | `{ chatId, id, label?, react?: enum['👍','👎','👏','🙂','😀','😕','🎉','❤','🚀','✔'] }` (spec `UpdateChatMessageDto.react` is this ten-value enum, not free text; at least 1 of `label`/`react`) | `PUT …/messages/{id}` |
| `yougile_delete_message` | D | `{ chatId, id, confirm:true }` | `PUT … {deleted:true}` |

### 6.8 Webhooks
`event` is validated with the regex `^[a-z_.*-]+$` (it allows the vendor's regexp forms such as `task-*`).
`filters` is `z.array(z.object({ name: z.enum(['location','title','chat_message']), value: z.array(z.string()) })).default([])` (spec `WebhookFilters`: `{name, value: string[]}`, both required).
| `yougile_list_webhooks` | R | `{ includeDeleted? }` | `GET /webhooks` |
|---|---|---|---|
| `yougile_create_webhook` | W | `{ url: z.string().url().startsWith('https://'), event, filters? }` | `POST /webhooks` |
| `yougile_update_webhook` | W | `{ id, url?, event?, filters?, disabled?: boolean }` | `PUT /webhooks/{id}` |
| `yougile_delete_webhook` | D | `{ id, confirm:true }` | `PUT /webhooks/{id} {deleted:true}` |

### 6.9 Soft delete of structure (D)
`yougile_delete_board`, `yougile_delete_column`, `yougile_delete_project`, `yougile_delete_department`,
`yougile_delete_group_chat`. Each takes `{ id, confirm: z.literal(true) }` and sends `PUT {deleted:true}`. Each description says
the delete is soft and can be undone with `yougile_restore`.

### 6.10 Deferred (v1.1, design only)
`yougile_upload_file { path }`: multipart to `/upload-file`. It may read only files under `YOUGILE_UPLOAD_ROOT` (a new env var,
realpath-checked), with a max size of 50 MB.

Implementer rule: **cross-check every DTO against the saved OpenAPI**. Where this catalogue differs from the spec, follow the spec, then fix this file in the same change.

**Total v1: 66 tools** (25 R, 29 W, 12 D). This is the authoritative list. Implementers may not add tools without updating this file.

## 7. Safe mutation model
1. **Three tiers by env.** Read-only by default. Writes and destructive operations are opt-in, and a tool that is not enabled is
   **not registered**, so the model never sees it.
2. Destructive tools require `confirm: true` in the input schema (a literal), which forces the model to make a deliberate call.
3. Partial updates send **only the keys the caller provided** (`undefined` keys are stripped). An update with zero fields is rejected locally.
4. Wholesale-replace fields (`checklists`, `subtasks`, `users` maps, chat subscribers) are documented as replace in the tool description.
   The dedicated append/add tools do read-modify-write.
5. Creates carry an idempotencyKey where the API supports one (§5.3).
6. Every mutation's result echoes the server response (or the re-read object) so the model can verify it.
7. Real HTTP `DELETE` is used only for `remove_user` and `delete_project_role`. The runtime never calls `auth/*`.

## 8. Testing plan
- **Unit (vitest, no network):** config parsing (defaults, bounds, https rule, secret-free errors); RateLimiter with a fake
  clock (burst, refill, FIFO, abort, penalize); retry matrix per §5.3, including idempotencyKey reuse across attempts and the
  rule that PUT is not retried on timeout; error sanitizer (key scrubbing, 300-char cap, status mapping, `Retry-After` parsing);
  paginate (next walking, maxItems truncation, page size ≤1000).
- **Tool tests:** create the server with a fake fetch and an in-memory transport (`InMemoryTransport.createLinkedPair()` from
  the SDK), then call `listTools` and `callTool`. Assert: the gating sets (count and names per env combination), the exact method/path/query/body
  sent for each tool (table-driven over §6), that undefined fields are stripped, read-modify-write ordering, and that error results are `isError`.
- **Smoke (manual, optional, not in CI):** `npm run inspect` launches `@modelcontextprotocol/inspector` against `dist/index.js` with a
  real key in a sandbox company. Verify open risks §10 1–3 there once.
- CI gate: `npm run check` = `tsc --noEmit && eslint . && vitest run`.

## 9. Ownership
| Area | Owner |
|---|---|
| `docs/ARCHITECTURE.md`, `docs/architecture-handoff.md` | Architecture lead (Claude Opus) |
| Scaffold: `package.json`, lockfile, tsconfig, eslint/prettier/vitest config, `src/**` stubs, `test/helpers`, `README.md` (RU), `AGENTS.md`, `docs/IMPLEMENTATION.md` | Scaffold worker (Claude Sonnet) |
| Implementation of `src/http/*`, `src/config.ts`, `src/tools/*`, `src/format/*` and all tests | Implementation lead (Codex Sol), dispatched by root after handoff |

## 10. Open risks (verify once, live, during implementation)
1. `GET /companies{*companyId}` has an odd path template. Try `/companies` first. If that 404s, drop `yougile_get_company`.
2. The timestamp unit is assumed to be ms (based on the spec examples).
3. The error body shape and 429 / `Retry-After` behaviour on data endpoints. The sanitizer handles both NestJS `{message}` and `{error}`.
4. `CreateChatMessageDto` requires `textHtml` and `label`, which we always send. A task's chat id is assumed to be the task id.
5. `ProjectPermissionsDto` and `WebhookFilters` are deep. They pass through as records, and the server validates them.
6. Re-check the spec's SHA-256 (provenance file) before implementing. If the spec changed, update this file first.

## QA corrections (2026-10-17)
- Sprint sticker `begin`/`end` are epoch **seconds** per the vendor DTO descriptions and examples. Task deadlines and chat timestamps remain epoch milliseconds. ISO date inputs use explicit `Z` or an offset for datetimes; date-only `YYYY-MM-DD` is UTC.
- `WebhookFilters.name` is an enum in the schema, although the vendor example depicts a scalar filter value. `CheckList.items` has a single-object `allOf` structure, while its prose says array; the tool uses an array. Bare `GET /companies` is derived from the unusual `/companies{*companyId}` template and remains unverified live.
- Every 429 penalizes the process-wide limiter; `Retry-After` values are capped at 60 seconds for the shared penalty. A rejected 429 whose retry wait exceeds the call deadline reports `rate_limited`, preserving the known outcome. A successful empty body yields no value; a successful non-JSON body yields a non-retryable protocol error.
- `YOUGILE_LOG_LEVEL` is reserved for future diagnostics. No runtime request diagnostics are emitted: even a debug stack can include credentials or full URLs from fetch implementations, conflicting with the secret rule in §5.4. Startup config failures still produce a sanitized stderr line. The §5.4 instruction to log unexpected stacks is superseded by this rule.
