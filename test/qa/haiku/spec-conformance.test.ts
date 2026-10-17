// QA (haiku): drives every registered tool (all gates open) through an in-memory MCP client and a
// fake fetch, then checks each outgoing HTTP call against docs/research/raw/yougile-openapi-v2.json:
// method + path template, query names/types, body keys, spec-required keys and spec enums.
// No network: fetch is faked and the rate limiter is stubbed.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { YouGileClient } from '../../../src/http/client.js';
import type { RateLimiter } from '../../../src/http/rateLimiter.js';
import { createServer } from '../../../src/server.js';

type Json = Record<string, unknown>;

interface Spec {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
}
const spec = JSON.parse(
  readFileSync(
    new URL('../../../docs/research/raw/yougile-openapi-v2.json', import.meta.url),
    'utf8',
  ),
) as Spec;
const schemas = spec.components.schemas;

// Free-form passthrough objects in the spec (ProjectPermissionsDto, custom fields); not validated deeply.
const PASSTHROUGH_KEYS = new Set(['permissions', 'customFields', 'fields']);

function deref(s: Json): Json {
  const ref = s['$ref'];
  return typeof ref === 'string' ? deref(schemas[ref.split('/').pop() ?? ''] ?? {}) : s;
}

function objectShape(s: Json): { props: Record<string, Json>; required: string[] } {
  const r = deref(s);
  let props: Record<string, Json> = { ...((r['properties'] as Record<string, Json>) ?? {}) };
  const required = [...((r['required'] as string[]) ?? [])];
  for (const part of (r['allOf'] as Json[] | undefined) ?? []) {
    const m = objectShape(part);
    props = { ...props, ...m.props };
    required.push(...m.required);
  }
  return { props, required };
}

function check(value: unknown, schema: Json, where: string, out: string[]): void {
  const s = deref(schema);
  if (Array.isArray(value)) {
    const items = s['items'] as Json | undefined;
    value.forEach((v, i) => check(v, items ?? s, `${where}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const { props, required } = objectShape(s);
    if (Object.keys(props).length === 0) return; // map or free-form object
    const obj = value as Json;
    for (const key of Object.keys(obj)) {
      if (!(key in props)) {
        out.push(`${where}.${key} is not defined in the spec`);
        continue;
      }
      if (PASSTHROUGH_KEYS.has(key)) continue;
      check(obj[key], props[key] as Json, `${where}.${key}`, out);
    }
    for (const r of required)
      if (obj[r] === undefined) out.push(`${where} lacks spec-required ${r}`);
    return;
  }
  const enumValues = s['enum'];
  if (typeof value === 'string' && Array.isArray(enumValues) && !enumValues.includes(value))
    out.push(`${where} = ${JSON.stringify(value)} is not a spec enum value`);
}

function opFor(method: string, pathname: string): { tpl: string; op: Json } | undefined {
  for (const [tpl, ops] of Object.entries(spec.paths)) {
    const op = ops[method.toLowerCase()];
    if (!op) continue;
    const pattern = tpl
      .split(/(\{\*?\w+\})/)
      .map((part) =>
        part.startsWith('{*')
          ? '.*'
          : part.startsWith('{')
            ? '[^/]+'
            : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('');
    if (new RegExp(`^${pattern}$`).test(pathname)) return { tpl, op };
  }
  return undefined;
}

function checkQuery(op: Json, url: URL, where: string, out: string[]): void {
  const params = ((op['parameters'] as Json[] | undefined) ?? []).filter(
    (p) => p['in'] === 'query',
  );
  for (const [k, v] of url.searchParams) {
    const p = params.find((x) => x['name'] === k);
    if (!p) {
      out.push(`${where} query ${k} is not defined in the spec`);
      continue;
    }
    const type = (p['schema'] as Json | undefined)?.['type'];
    if (type === 'number' && !/^-?\d+(\.\d+)?$/.test(v))
      out.push(`${where} query ${k}=${v} is not a number`);
    if (type === 'boolean' && v !== 'true' && v !== 'false')
      out.push(`${where} query ${k}=${v} is not a boolean`);
  }
}

// Captured HTTP request, plus a fake response that keeps the tools' read-modify-write paths happy.
interface Recorded {
  method: string;
  url: URL;
  body: Json | undefined;
}
const TASK = {
  id: 't1',
  title: 'T',
  columnId: 'c1',
  subtasks: ['t9'],
  assigned: [],
  checklists: [],
  stickers: {},
  deadline: { deadline: 1700000000000, blockedPoints: ['bp'], links: ['l1'] },
  timeTracking: { plan: 2, work: 1 },
  timestamp: 1700000000000,
};
function respond(method: string, url: URL): Response {
  const found = opFor(method, url.pathname);
  const single = found ? found.tpl.endsWith('}') : true;
  let payload: Json;
  if (method === 'GET' && url.pathname === '/api-v2/tasks/t1') payload = TASK;
  else if (method === 'GET' && !single)
    payload = { content: [], paging: { count: 0, limit: 50, offset: 0, next: false } };
  else payload = { id: 'resp-id' };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function recordingFetch(calls: Recorded[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : undefined;
    calls.push({ method, url, body });
    return respond(method, url);
  }) as typeof fetch;
}

// One valid, spec-shaped invocation per tool. Covers all 66 registered tools (25 R, 29 W, 12 D).
const SAMPLES: Array<[string, Json]> = [
  ['yougile_whoami', {}],
  ['yougile_get_company', {}],
  ['yougile_list_users', {}],
  ['yougile_get_user', { id: 'u1' }],
  ['yougile_list_projects', {}],
  ['yougile_get_project', { id: 'p1' }],
  ['yougile_list_project_roles', { projectId: 'p1' }],
  ['yougile_get_project_role', { projectId: 'p1', id: 'r1' }],
  ['yougile_list_departments', {}],
  ['yougile_get_department', { id: 'd1' }],
  ['yougile_list_boards', {}],
  ['yougile_get_board', { id: 'b1' }],
  ['yougile_list_columns', {}],
  ['yougile_get_column', { id: 'c1' }],
  ['yougile_list_tasks', { assignedTo: ['u1', 'u2'], includeDeleted: true }],
  ['yougile_get_task', { id: 't1' }],
  ['yougile_get_task_log', { id: 't1', limit: 5, before: 1700000000000 }],
  ['yougile_get_task_chat_subscribers', { id: 't1' }],
  ['yougile_list_stickers', { kind: 'string' }],
  ['yougile_get_sticker', { kind: 'string', id: 's1' }],
  ['yougile_list_group_chats', {}],
  ['yougile_get_group_chat', { id: 'g1' }],
  ['yougile_list_messages', { chatId: 'g1', since: 1700000000000, includeSystem: true }],
  ['yougile_get_message', { chatId: 'g1', id: 1653028146646 }],
  ['yougile_list_webhooks', {}],
  ['yougile_invite_user', { email: 'qa@example.com', isAdmin: false }],
  ['yougile_update_user', { id: 'u1', isAdmin: true }],
  ['yougile_create_project', { title: 'P', users: { u1: 'admin' } }],
  ['yougile_update_project', { id: 'p1', title: 'P2' }],
  ['yougile_create_project_role', { projectId: 'p1', name: 'R', permissions: { editTitle: true } }],
  ['yougile_update_project_role', { projectId: 'p1', id: 'r1', name: 'R2' }],
  ['yougile_create_department', { title: 'D', parentId: 'd0', users: { u1: 'worker' } }],
  ['yougile_update_department', { id: 'd1', title: 'D2' }],
  ['yougile_create_board', { title: 'B', projectId: 'p1', stickers: { timer: true } }],
  ['yougile_update_board', { id: 'b1', title: 'B2' }],
  ['yougile_create_column', { title: 'C', boardId: 'b1', color: 3 }],
  ['yougile_update_column', { id: 'c1', title: 'C2' }],
  [
    'yougile_create_task',
    {
      title: 'T',
      columnId: 'c1',
      deadline: { deadline: '2026-10-20T12:00:00Z', withTime: true },
      timeTracking: { plan: 1 },
      checklists: [{ title: 'L', items: [{ title: 'i' }] }],
      stickers: { st1: 'v' },
      color: 'task-red',
    },
  ],
  [
    'yougile_update_task',
    { id: 't1', title: 'T2', deadline: { deadline: 1700000000000 }, timeTracking: { plan: 3 } },
  ],
  ['yougile_move_task', { id: 't1', columnId: 'c2' }],
  [
    'yougile_set_task_checklists',
    {
      id: 't1',
      checklists: [{ title: 'L', items: [{ title: 'i', isCompleted: true }] }],
      mode: 'replace',
    },
  ],
  ['yougile_set_task_subtasks', { id: 't1', subtasks: ['t2'], mode: 'replace' }],
  ['yougile_set_task_chat_subscribers', { id: 't1', users: ['u1'] }],
  ['yougile_restore', { kind: 'task', id: 't1' }],
  ['yougile_restore', { kind: 'board', id: 'b1' }],
  ['yougile_restore', { kind: 'column', id: 'c1' }],
  ['yougile_restore', { kind: 'project', id: 'p1' }],
  ['yougile_restore', { kind: 'department', id: 'd1' }],
  ['yougile_restore', { kind: 'group_chat', id: 'g1' }],
  ['yougile_restore', { kind: 'string_sticker', id: 's1' }],
  ['yougile_restore', { kind: 'sprint_sticker', id: 's2' }],
  ['yougile_list_stickers', { kind: 'sprint', boardId: 'b1' }],
  ['yougile_get_sticker', { kind: 'sprint', id: 's2' }],
  ['yougile_update_sticker', { kind: 'sprint', id: 's2', name: 'Sprints 2' }],
  [
    'yougile_create_sticker_state',
    { kind: 'sprint', stickerId: 's2', name: 'Sprint 1', begin: 1655989112, end: 1656012328 },
  ],
  [
    'yougile_update_sticker_state',
    { kind: 'sprint', stickerId: 's2', stateId: 'st2', name: 'Sprint 1b', begin: 1655989112 },
  ],
  ['yougile_delete_sticker', { kind: 'sprint', id: 's2', confirm: true }],
  [
    'yougile_create_sticker',
    { kind: 'string', name: 'S', icon: 'star', states: [{ name: 'Low', color: '#00ff00' }] },
  ],
  [
    'yougile_create_sticker',
    {
      kind: 'sprint',
      name: 'Sprints',
      states: [{ name: 'S1', begin: 1655989112, end: 1656012328 }],
    },
  ],
  ['yougile_update_sticker', { kind: 'string', id: 's1', name: 'S2', icon: 'star' }],
  ['yougile_create_sticker_state', { kind: 'string', stickerId: 's1', name: 'X', color: '#fff' }],
  ['yougile_update_sticker_state', { kind: 'string', stickerId: 's1', stateId: 'st1', name: 'Y' }],
  ['yougile_create_group_chat', { title: 'G', users: { u1: { notified: true } } }],
  ['yougile_update_group_chat', { id: 'g1', title: 'G2' }],
  ['yougile_send_message', { chatId: 'g1', text: 'hi' }],
  ['yougile_update_message', { chatId: 'g1', id: 1653028146646, react: '👍' }],
  [
    'yougile_create_webhook',
    {
      url: 'https://example.com/hook',
      event: 'task-created',
      filters: [{ name: 'location', value: ['p1'] }],
    },
  ],
  ['yougile_update_webhook', { id: 'w1', disabled: true }],
  ['yougile_remove_user', { id: 'u1', confirm: true }],
  ['yougile_delete_project_role', { projectId: 'p1', id: 'r1', confirm: true }],
  ['yougile_delete_task', { id: 't1', confirm: true }],
  ['yougile_delete_project', { id: 'p1', confirm: true }],
  ['yougile_delete_board', { id: 'b1', confirm: true }],
  ['yougile_delete_column', { id: 'c1', confirm: true }],
  ['yougile_delete_department', { id: 'd1', confirm: true }],
  ['yougile_delete_group_chat', { id: 'g1', confirm: true }],
  ['yougile_delete_sticker', { kind: 'string', id: 's1', confirm: true }],
  [
    'yougile_delete_sticker_state',
    { kind: 'string', stickerId: 's1', stateId: 'st1', confirm: true },
  ],
  ['yougile_delete_message', { chatId: 'g1', id: 1653028146646, confirm: true }],
  ['yougile_delete_webhook', { id: 'w1', confirm: true }],
];

async function sweep(): Promise<{ registered: string[]; violations: string[]; errors: string[] }> {
  const config = loadConfig({
    YOUGILE_API_KEY: 'qa-haiku-key',
    YOUGILE_ALLOW_WRITES: 'true',
    YOUGILE_ALLOW_DESTRUCTIVE: 'true',
  });
  const calls: Recorded[] = [];
  const limiter = { acquire: async () => undefined, penalize: () => undefined, perMinute: 50 };
  const client = new YouGileClient(
    config,
    limiter as unknown as RateLimiter,
    recordingFetch(calls),
  );
  const server = createServer(config, { client });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'haiku-qa', version: '0.0.0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);

  const registered = (await mcp.listTools()).tools.map((t) => t.name).sort();
  const perTool: Array<{ tool: string; call: Recorded }> = [];
  const errors: string[] = [];
  for (const [tool, args] of SAMPLES) {
    const start = calls.length;
    const res = await mcp.callTool({ name: tool, arguments: args });
    if (res.isError) errors.push(`${tool}: ${JSON.stringify(res.content)}`);
    for (const call of calls.slice(start)) perTool.push({ tool, call });
  }

  const violations: string[] = [];
  for (const tool of new Set(SAMPLES.map(([t]) => t))) {
    if (!perTool.some((p) => p.tool === tool)) violations.push(`${tool}: made no HTTP call`);
  }
  for (const { tool, call } of perTool) {
    const where = `${tool} ${call.method} ${call.url.pathname}`;
    const found = opFor(call.method, call.url.pathname);
    if (!found) {
      violations.push(`${where}: endpoint is not in the spec`);
      continue;
    }
    checkQuery(found.op, call.url, where, violations);
    const body = (found.op['requestBody'] as Json | undefined)?.['content'] as Json | undefined;
    const schema = (body?.['application/json'] as Json | undefined)?.['schema'] as Json | undefined;
    if (call.body !== undefined) {
      if (!schema) violations.push(`${where}: sends a body but the spec defines none`);
      else check(call.body, schema, `${where} body`, violations);
    }
  }
  return { registered, violations, errors };
}

describe('spec conformance sweep (all 66 tools)', () => {
  it('every tool maps to a spec endpoint with spec-valid query and body', async () => {
    const { registered, violations, errors } = await sweep();
    expect(registered).toHaveLength(66);
    expect(new Set(SAMPLES.map(([t]) => t))).toEqual(new Set(registered));
    expect(errors).toEqual([]);
    expect(violations).toEqual([]);
  });
});
