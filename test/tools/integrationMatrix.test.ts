import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { YouGileClient } from '../../src/http/client.js';
import { RateLimiter } from '../../src/http/rateLimiter.js';
import { createServer } from '../../src/server.js';
import { createFakeFetch, type ScriptedResponse } from '../helpers/fakeFetch.js';

const READ = [
  'yougile_whoami',
  'yougile_get_company',
  'yougile_list_users',
  'yougile_get_user',
  'yougile_list_projects',
  'yougile_get_project',
  'yougile_list_project_roles',
  'yougile_get_project_role',
  'yougile_list_departments',
  'yougile_get_department',
  'yougile_list_boards',
  'yougile_get_board',
  'yougile_list_columns',
  'yougile_get_column',
  'yougile_list_tasks',
  'yougile_get_task',
  'yougile_get_task_log',
  'yougile_get_task_chat_subscribers',
  'yougile_list_stickers',
  'yougile_get_sticker',
  'yougile_list_group_chats',
  'yougile_get_group_chat',
  'yougile_list_messages',
  'yougile_get_message',
  'yougile_list_webhooks',
];
const WRITE = [
  'yougile_invite_user',
  'yougile_update_user',
  'yougile_create_project',
  'yougile_update_project',
  'yougile_create_project_role',
  'yougile_update_project_role',
  'yougile_create_department',
  'yougile_update_department',
  'yougile_create_board',
  'yougile_update_board',
  'yougile_create_column',
  'yougile_update_column',
  'yougile_create_task',
  'yougile_update_task',
  'yougile_move_task',
  'yougile_set_task_checklists',
  'yougile_set_task_subtasks',
  'yougile_set_task_chat_subscribers',
  'yougile_restore',
  'yougile_create_sticker',
  'yougile_update_sticker',
  'yougile_create_sticker_state',
  'yougile_update_sticker_state',
  'yougile_create_group_chat',
  'yougile_update_group_chat',
  'yougile_send_message',
  'yougile_update_message',
  'yougile_create_webhook',
  'yougile_update_webhook',
];
const DESTRUCTIVE = [
  'yougile_remove_user',
  'yougile_delete_project_role',
  'yougile_delete_task',
  'yougile_delete_project',
  'yougile_delete_board',
  'yougile_delete_column',
  'yougile_delete_department',
  'yougile_delete_group_chat',
  'yougile_delete_sticker',
  'yougile_delete_sticker_state',
  'yougile_delete_message',
  'yougile_delete_webhook',
];

async function connect(env: Record<string, string>, script: Array<ScriptedResponse | Error> = []) {
  const config = loadConfig({
    YOUGILE_API_KEY: 'test-key',
    YOUGILE_RATE_LIMIT_PER_MIN: '50',
    ...env,
  });
  const { fetch: fakeFetch, calls } = createFakeFetch(script);
  const client = new YouGileClient(config, new RateLimiter(config.rateLimitPerMin), fakeFetch);
  const server = createServer(config, { client });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'matrix', version: '0.0.0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, calls };
}

const names = async (mcp: Client) => (await mcp.listTools()).tools.map((t) => t.name).sort();

describe('gating sets (66 tools)', () => {
  it('read-only: 25 tools', async () => {
    const { mcp } = await connect({});
    expect(await names(mcp)).toEqual([...READ].sort());
  });
  it('writes: 25 + 29 = 54 tools', async () => {
    const { mcp } = await connect({ YOUGILE_ALLOW_WRITES: 'true' });
    const got = await names(mcp);
    expect(got).toHaveLength(54);
    expect(got).toEqual([...READ, ...WRITE].sort());
  });
  it('destructive: all 66 tools, names unique', async () => {
    const { mcp } = await connect({
      YOUGILE_ALLOW_WRITES: 'true',
      YOUGILE_ALLOW_DESTRUCTIVE: 'true',
    });
    const got = await names(mcp);
    expect(got).toHaveLength(66);
    expect(new Set(got).size).toBe(66);
    expect(got).toEqual([...READ, ...WRITE, ...DESTRUCTIVE].sort());
  });
  it('destructive without writes is a config error', () => {
    expect(() => loadConfig({ YOUGILE_API_KEY: 'k', YOUGILE_ALLOW_DESTRUCTIVE: 'true' })).toThrow(
      /ALLOW_WRITES/,
    );
  });
  it('every destructive tool requires confirm: true and makes no request without it', async () => {
    const { mcp, calls } = await connect({
      YOUGILE_ALLOW_WRITES: 'true',
      YOUGILE_ALLOW_DESTRUCTIVE: 'true',
    });
    const tools = (await mcp.listTools()).tools.filter((t) => DESTRUCTIVE.includes(t.name));
    expect(tools).toHaveLength(12);
    for (const t of tools) {
      const props = t.inputSchema.properties as Record<
        string,
        { const?: unknown; enum?: unknown[] }
      >;
      expect(props.confirm?.const ?? props.confirm?.enum?.[0], t.name).toBe(true);
      expect(t.inputSchema.required, t.name).toContain('confirm');
    }
    expect(calls).toHaveLength(0);
  });
  it('read tools are annotated readOnly, destructive tools destructive', async () => {
    const { mcp } = await connect({
      YOUGILE_ALLOW_WRITES: 'true',
      YOUGILE_ALLOW_DESTRUCTIVE: 'true',
    });
    for (const t of (await mcp.listTools()).tools) {
      if (READ.includes(t.name)) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      if (DESTRUCTIVE.includes(t.name)) expect(t.annotations?.destructiveHint, t.name).toBe(true);
    }
  });
});

interface Row {
  tool: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
  query?: Record<string, string>;
  /** Subset match against the JSON body. */
  body?: Record<string, unknown>;
  /** Keys that must be absent from the body (partial update stripping). */
  absent?: string[];
  response?: unknown;
}

const LIST = { paging: { count: 0, limit: 50, offset: 0, next: false }, content: [] };
const T = { id: 't1', title: 'T', columnId: 'c', timestamp: 1700000000000 };

const rows: Row[] = [
  {
    tool: 'yougile_whoami',
    args: {},
    method: 'GET',
    path: '/api-v2/users/me',
    response: { id: 'u' },
  },
  {
    tool: 'yougile_get_company',
    args: {},
    method: 'GET',
    path: '/api-v2/companies',
    response: { id: 'c' },
  },
  {
    tool: 'yougile_list_users',
    args: { email: 'a@b.co', projectId: 'p', limit: 10, offset: 5 },
    method: 'GET',
    path: '/api-v2/users',
    query: { email: 'a@b.co', projectId: 'p', limit: '10', offset: '5' },
    response: LIST,
  },
  {
    tool: 'yougile_get_user',
    args: { id: 'u1' },
    method: 'GET',
    path: '/api-v2/users/u1',
    response: { id: 'u1' },
  },
  {
    tool: 'yougile_invite_user',
    args: { email: 'a@b.co', isAdmin: true },
    method: 'POST',
    path: '/api-v2/users',
    body: { email: 'a@b.co', isAdmin: true },
    absent: ['messengerOnly'],
  },
  {
    tool: 'yougile_update_user',
    args: { id: 'u1', messengerOnly: true },
    method: 'PUT',
    path: '/api-v2/users/u1',
    body: { messengerOnly: true },
    absent: ['isAdmin', 'id'],
  },
  {
    tool: 'yougile_remove_user',
    args: { id: 'u1', confirm: true },
    method: 'DELETE',
    path: '/api-v2/users/u1',
  },

  {
    tool: 'yougile_list_projects',
    args: { title: 'P', includeDeleted: true },
    method: 'GET',
    path: '/api-v2/projects',
    query: { title: 'P', includeDeleted: 'true', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_project',
    args: { id: 'p1' },
    method: 'GET',
    path: '/api-v2/projects/p1',
    response: { id: 'p1' },
  },
  {
    tool: 'yougile_create_project',
    args: { title: 'P', users: { u1: 'admin' } },
    method: 'POST',
    path: '/api-v2/projects',
    body: { title: 'P', users: { u1: 'admin' } },
  },
  {
    tool: 'yougile_update_project',
    args: { id: 'p1', title: 'N' },
    method: 'PUT',
    path: '/api-v2/projects/p1',
    body: { title: 'N' },
    absent: ['users', 'id'],
  },
  {
    tool: 'yougile_delete_project',
    args: { id: 'p1', confirm: true },
    method: 'PUT',
    path: '/api-v2/projects/p1',
    body: { deleted: true },
  },
  {
    tool: 'yougile_restore',
    args: { kind: 'project', id: 'p1' },
    method: 'PUT',
    path: '/api-v2/projects/p1',
    body: { deleted: false },
  },
  {
    tool: 'yougile_restore',
    args: { kind: 'group_chat', id: 'g1' },
    method: 'PUT',
    path: '/api-v2/group-chats/g1',
    body: { deleted: false },
  },
  {
    tool: 'yougile_restore',
    args: { kind: 'string_sticker', id: 's1' },
    method: 'PUT',
    path: '/api-v2/string-stickers/s1',
    body: { deleted: false },
  },
  {
    tool: 'yougile_restore',
    args: { kind: 'sprint_sticker', id: 's1' },
    method: 'PUT',
    path: '/api-v2/sprint-stickers/s1',
    body: { deleted: false },
  },
  {
    tool: 'yougile_restore',
    args: { kind: 'task', id: 't1' },
    method: 'PUT',
    path: '/api-v2/tasks/t1',
    body: { deleted: false },
  },

  {
    tool: 'yougile_list_project_roles',
    args: { projectId: 'p1', name: 'r' },
    method: 'GET',
    path: '/api-v2/projects/p1/roles',
    query: { name: 'r', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_project_role',
    args: { projectId: 'p1', id: 'r1' },
    method: 'GET',
    path: '/api-v2/projects/p1/roles/r1',
    response: { id: 'r1' },
  },
  {
    tool: 'yougile_create_project_role',
    args: { projectId: 'p1', name: 'R', permissions: { editTitle: true } },
    method: 'POST',
    path: '/api-v2/projects/p1/roles',
    body: { name: 'R', permissions: { editTitle: true } },
    absent: ['projectId'],
  },
  {
    tool: 'yougile_update_project_role',
    args: { projectId: 'p1', id: 'r1', description: 'd' },
    method: 'PUT',
    path: '/api-v2/projects/p1/roles/r1',
    body: { description: 'd' },
    absent: ['name', 'projectId', 'id'],
  },
  {
    tool: 'yougile_delete_project_role',
    args: { projectId: 'p1', id: 'r1', confirm: true },
    method: 'DELETE',
    path: '/api-v2/projects/p1/roles/r1',
  },

  {
    tool: 'yougile_list_departments',
    args: { parentId: 'x', title: 'd' },
    method: 'GET',
    path: '/api-v2/departments',
    query: { includeDeleted: 'false', parentId: 'x', title: 'd', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_department',
    args: { id: 'd1' },
    method: 'GET',
    path: '/api-v2/departments/d1',
    response: { id: 'd1' },
  },
  {
    tool: 'yougile_create_department',
    args: { title: 'D', parentId: 'x' },
    method: 'POST',
    path: '/api-v2/departments',
    body: { title: 'D', parentId: 'x' },
  },
  {
    tool: 'yougile_update_department',
    args: { id: 'd1', users: { u: 'admin' } },
    method: 'PUT',
    path: '/api-v2/departments/d1',
    body: { users: { u: 'admin' } },
    absent: ['title'],
  },
  {
    tool: 'yougile_delete_department',
    args: { id: 'd1', confirm: true },
    method: 'PUT',
    path: '/api-v2/departments/d1',
    body: { deleted: true },
  },

  {
    tool: 'yougile_list_boards',
    args: { projectId: 'p1' },
    method: 'GET',
    path: '/api-v2/boards',
    query: { includeDeleted: 'false', projectId: 'p1', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_board',
    args: { id: 'b1' },
    method: 'GET',
    path: '/api-v2/boards/b1',
    response: { id: 'b1' },
  },
  {
    tool: 'yougile_create_board',
    args: { title: 'B', projectId: 'p1', stickers: { deadline: true, custom: { s: true } } },
    method: 'POST',
    path: '/api-v2/boards',
    body: { title: 'B', projectId: 'p1', stickers: { deadline: true, custom: { s: true } } },
  },
  {
    tool: 'yougile_update_board',
    args: { id: 'b1', projectId: 'p2' },
    method: 'PUT',
    path: '/api-v2/boards/b1',
    body: { projectId: 'p2' },
    absent: ['title'],
  },
  {
    tool: 'yougile_delete_board',
    args: { id: 'b1', confirm: true },
    method: 'PUT',
    path: '/api-v2/boards/b1',
    body: { deleted: true },
  },

  {
    tool: 'yougile_list_columns',
    args: { boardId: 'b1' },
    method: 'GET',
    path: '/api-v2/columns',
    query: { includeDeleted: 'false', boardId: 'b1', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_column',
    args: { id: 'c1' },
    method: 'GET',
    path: '/api-v2/columns/c1',
    response: { id: 'c1' },
  },
  {
    tool: 'yougile_create_column',
    args: { title: 'C', boardId: 'b1', color: 3 },
    method: 'POST',
    path: '/api-v2/columns',
    body: { title: 'C', boardId: 'b1', color: 3 },
  },
  {
    tool: 'yougile_update_column',
    args: { id: 'c1', color: 5 },
    method: 'PUT',
    path: '/api-v2/columns/c1',
    body: { color: 5 },
    absent: ['title', 'boardId'],
  },
  {
    tool: 'yougile_delete_column',
    args: { id: 'c1', confirm: true },
    method: 'PUT',
    path: '/api-v2/columns/c1',
    body: { deleted: true },
  },

  {
    tool: 'yougile_list_tasks',
    args: { columnId: 'c1', assignedTo: ['u1', 'u2'], title: 'x' },
    method: 'GET',
    path: '/api-v2/task-list',
    query: { columnId: 'c1', assignedTo: 'u1,u2', title: 'x', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_task',
    args: { id: 't1' },
    method: 'GET',
    path: '/api-v2/tasks/t1',
    response: T,
  },
  {
    tool: 'yougile_get_task_log',
    args: { id: 't1', limit: 20, before: 1700000000000 },
    method: 'GET',
    path: '/api-v2/tasks/t1/log',
    query: { limit: '20', before: '1700000000000' },
    response: LIST,
  },
  {
    tool: 'yougile_get_task_chat_subscribers',
    args: { id: 't1' },
    method: 'GET',
    path: '/api-v2/tasks/t1/chat-subscribers',
    response: { content: ['u1'] },
  },
  {
    tool: 'yougile_create_task',
    args: { title: 'T', columnId: 'c1', assigned: ['u1'] },
    method: 'POST',
    path: '/api-v2/tasks',
    body: { title: 'T', columnId: 'c1', assigned: ['u1'] },
    response: { id: 't1' },
  },
  {
    tool: 'yougile_update_task',
    args: { id: 't1', completed: true },
    method: 'PUT',
    path: '/api-v2/tasks/t1',
    body: { completed: true },
    absent: ['title', 'id'],
  },
  {
    tool: 'yougile_move_task',
    args: { id: 't1', columnId: 'c2' },
    method: 'PUT',
    path: '/api-v2/tasks/t1',
    body: { columnId: 'c2' },
  },
  {
    tool: 'yougile_set_task_chat_subscribers',
    args: { id: 't1', users: ['u1', 'u2'] },
    method: 'PUT',
    path: '/api-v2/tasks/t1/chat-subscribers',
    body: { content: ['u1', 'u2'] },
  },
  {
    tool: 'yougile_delete_task',
    args: { id: 't1', confirm: true },
    method: 'PUT',
    path: '/api-v2/tasks/t1',
    body: { deleted: true },
  },

  {
    tool: 'yougile_list_stickers',
    args: { kind: 'string', boardId: 'b1' },
    method: 'GET',
    path: '/api-v2/string-stickers',
    query: { boardId: 'b1', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_list_stickers',
    args: { kind: 'sprint', name: 'S' },
    method: 'GET',
    path: '/api-v2/sprint-stickers',
    query: { name: 'S', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_sticker',
    args: { kind: 'string', id: 's1' },
    method: 'GET',
    path: '/api-v2/string-stickers/s1',
    response: { id: 's1' },
  },
  {
    tool: 'yougile_create_sticker',
    args: { kind: 'string', name: 'S', states: [{ name: 'A' }] },
    method: 'POST',
    path: '/api-v2/string-stickers',
    body: { name: 'S', states: [{ name: 'A' }] },
  },
  {
    tool: 'yougile_create_sticker',
    args: { kind: 'sprint', name: 'Sp' },
    method: 'POST',
    path: '/api-v2/sprint-stickers',
    body: { name: 'Sp' },
  },
  {
    tool: 'yougile_update_sticker',
    args: { kind: 'string', id: 's1', name: 'N' },
    method: 'PUT',
    path: '/api-v2/string-stickers/s1',
    body: { name: 'N' },
    absent: ['kind', 'id'],
  },
  {
    tool: 'yougile_create_sticker_state',
    args: { kind: 'string', stickerId: 's1', name: 'A', color: 'red' },
    method: 'POST',
    path: '/api-v2/string-stickers/s1/states',
    body: { name: 'A' },
  },
  {
    tool: 'yougile_update_sticker_state',
    args: { kind: 'sprint', stickerId: 's1', stateId: 'st1', name: 'N' },
    method: 'PUT',
    path: '/api-v2/sprint-stickers/s1/states/st1',
    body: { name: 'N' },
    absent: ['stickerId', 'stateId'],
  },
  {
    tool: 'yougile_delete_sticker',
    args: { kind: 'string', id: 's1', confirm: true },
    method: 'PUT',
    path: '/api-v2/string-stickers/s1',
    body: { deleted: true },
  },
  {
    tool: 'yougile_delete_sticker_state',
    args: { kind: 'string', stickerId: 's1', stateId: 'st1', confirm: true },
    method: 'PUT',
    path: '/api-v2/string-stickers/s1/states/st1',
    body: { deleted: true },
  },

  {
    tool: 'yougile_list_group_chats',
    args: { title: 'g' },
    method: 'GET',
    path: '/api-v2/group-chats',
    query: { title: 'g', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_group_chat',
    args: { id: 'g1' },
    method: 'GET',
    path: '/api-v2/group-chats/g1',
    response: { id: 'g1' },
  },
  {
    tool: 'yougile_create_group_chat',
    args: { title: 'G', users: { u1: { notified: true } } },
    method: 'POST',
    path: '/api-v2/group-chats',
    body: { title: 'G', users: { u1: { notified: true } }, userRoleMap: {}, roleConfigMap: {} },
  },
  {
    tool: 'yougile_update_group_chat',
    args: { id: 'g1', title: 'N' },
    method: 'PUT',
    path: '/api-v2/group-chats/g1',
    body: { title: 'N' },
    absent: ['users'],
  },
  {
    tool: 'yougile_delete_group_chat',
    args: { id: 'g1', confirm: true },
    method: 'PUT',
    path: '/api-v2/group-chats/g1',
    body: { deleted: true },
  },
  {
    tool: 'yougile_list_messages',
    args: { chatId: 'g1', text: 'hi', includeSystem: true },
    method: 'GET',
    path: '/api-v2/chats/g1/messages',
    query: { text: 'hi', includeSystem: 'true', limit: '50', offset: '0' },
    response: LIST,
  },
  {
    tool: 'yougile_get_message',
    args: { chatId: 'g1', id: 5 },
    method: 'GET',
    path: '/api-v2/chats/g1/messages/5',
    response: { id: 5 },
  },
  {
    tool: 'yougile_send_message',
    args: { chatId: 'g1', text: 'a <b>\nc' },
    method: 'POST',
    path: '/api-v2/chats/g1/messages',
    body: { text: 'a <b>\nc', textHtml: 'a &lt;b&gt;<br>c', label: '' },
  },
  {
    tool: 'yougile_update_message',
    args: { chatId: 'g1', id: 5, react: '👍' },
    method: 'PUT',
    path: '/api-v2/chats/g1/messages/5',
    body: { react: '👍' },
    absent: ['label'],
  },
  {
    tool: 'yougile_delete_message',
    args: { chatId: 'g1', id: 5, confirm: true },
    method: 'PUT',
    path: '/api-v2/chats/g1/messages/5',
    body: { deleted: true },
  },

  {
    tool: 'yougile_list_webhooks',
    args: { includeDeleted: true },
    method: 'GET',
    path: '/api-v2/webhooks',
    query: { includeDeleted: 'true' },
    response: [],
  },
  {
    tool: 'yougile_create_webhook',
    args: { url: 'https://example.com/h', event: 'task-*' },
    method: 'POST',
    path: '/api-v2/webhooks',
    body: { url: 'https://example.com/h', event: 'task-*', filters: [] },
  },
  {
    tool: 'yougile_update_webhook',
    args: { id: 'w1', disabled: true },
    method: 'PUT',
    path: '/api-v2/webhooks/w1',
    body: { disabled: true },
    absent: ['url', 'event'],
  },
  {
    tool: 'yougile_delete_webhook',
    args: { id: 'w1', confirm: true },
    method: 'PUT',
    path: '/api-v2/webhooks/w1',
    body: { deleted: true },
  },
];

describe('request mapping matrix', () => {
  it.each(rows.map((r, i) => [`${r.tool} #${i}`, r] as const))('%s', async (_n, row) => {
    const { mcp, calls } = await connect(
      { YOUGILE_ALLOW_WRITES: 'true', YOUGILE_ALLOW_DESTRUCTIVE: 'true' },
      [
        { status: 200, body: row.response ?? { id: 'x' } },
        { status: 200, body: { id: 'x' } },
      ],
    );
    const res = await mcp.callTool({ name: row.tool, arguments: row.args });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    const call = calls[calls.length - 1]!;
    const url = new URL(call.url);
    expect(call.method).toBe(row.method);
    expect(url.pathname).toBe(row.path);
    expect(url.origin).toBe('https://yougile.com');
    if (row.query) expect(Object.fromEntries(url.searchParams.entries())).toEqual(row.query);
    if (row.body) expect(call.body).toMatchObject(row.body);
    for (const k of row.absent ?? []) expect(call.body as object, k).not.toHaveProperty(k);
    expect(call.headers.authorization).toBe('Bearer test-key');
    expect(JSON.stringify(res)).not.toContain('test-key');
  });

  it('create tools with idempotencyKey send one in the body', async () => {
    for (const [tool, args] of [
      ['yougile_create_project', { title: 'P' }],
      ['yougile_create_board', { title: 'B', projectId: 'p' }],
      ['yougile_create_column', { title: 'C', boardId: 'b' }],
      ['yougile_create_task', { title: 'T' }],
    ] as const) {
      const { mcp, calls } = await connect({ YOUGILE_ALLOW_WRITES: 'true' }, [
        { body: { id: 'x' } },
      ]);
      await mcp.callTool({ name: tool, arguments: args });
      const body = calls[0]!.body as { idempotencyKey?: string };
      const headerKey = calls[0]!.headers['idempotency-key'];
      expect(body.idempotencyKey ?? headerKey, tool).toBeTruthy();
    }
  });

  it('empty updates are rejected locally without any HTTP request', async () => {
    const { mcp, calls } = await connect({ YOUGILE_ALLOW_WRITES: 'true' });
    for (const [tool, args] of [
      ['yougile_update_user', { id: 'u' }],
      ['yougile_update_project', { id: 'p' }],
      ['yougile_update_project_role', { projectId: 'p', id: 'r' }],
      ['yougile_update_department', { id: 'd' }],
      ['yougile_update_board', { id: 'b' }],
      ['yougile_update_column', { id: 'c' }],
      ['yougile_update_task', { id: 't' }],
      ['yougile_update_group_chat', { id: 'g' }],
      ['yougile_update_webhook', { id: 'w' }],
    ] as const) {
      const res = await mcp.callTool({ name: tool, arguments: args });
      expect(res.isError, tool).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('set_task_checklists append reads the task before writing', async () => {
    const { mcp, calls } = await connect({ YOUGILE_ALLOW_WRITES: 'true' }, [
      { body: { ...T, checklists: [{ title: 'old', items: [] }] } },
      { body: { id: 't1' } },
    ]);
    const res = await mcp.callTool({
      name: 'yougile_set_task_checklists',
      arguments: { id: 't1', checklists: [{ title: 'new', items: [{ title: 'i' }] }] },
    });
    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    const titles = (calls[1]!.body as { checklists: Array<{ title: string }> }).checklists.map(
      (c) => c.title,
    );
    expect(titles).toEqual(['old', 'new']);
  });

  it('HTTP errors surface as sanitized isError results', async () => {
    const { mcp } = await connect({}, [
      { status: 404, body: { message: 'not found at https://yougile.com/x?key=test-key' } },
    ]);
    const res = await mcp.callTool({ name: 'yougile_get_project', arguments: { id: 'zz' } });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain('not_found');
    expect(text).not.toContain('test-key');
    expect(text).not.toContain('https://');
  });
});

describe('cancellation propagates to the HTTP request', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['yougile_whoami', {}],
    ['yougile_get_company', {}],
    ['yougile_list_users', {}],
    ['yougile_list_projects', {}],
    ['yougile_list_project_roles', { projectId: 'p' }],
    ['yougile_list_departments', {}],
    ['yougile_list_boards', {}],
    ['yougile_list_columns', {}],
    ['yougile_list_tasks', {}],
    ['yougile_get_task', { id: 't' }],
    ['yougile_list_stickers', { kind: 'string' }],
    ['yougile_get_sticker', { kind: 'string', id: 's' }],
    ['yougile_list_group_chats', {}],
    ['yougile_list_messages', { chatId: 'g' }],
    ['yougile_list_webhooks', {}],
    ['yougile_update_webhook', { id: 'w', disabled: true }],
    ['yougile_update_board', { id: 'b', title: 'x' }],
  ];

  it.each(cases)('%s', async (tool, args) => {
    const config = loadConfig({
      YOUGILE_API_KEY: 'test-key',
      YOUGILE_ALLOW_WRITES: 'true',
      YOUGILE_RATE_LIMIT_PER_MIN: '50',
    });
    let fetchSignal: AbortSignal | undefined;
    let started!: () => void;
    const fetchStarted = new Promise<void>((r) => (started = r));
    const hangingFetch = ((_url: unknown, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      started();
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        );
      });
    }) as typeof fetch;
    const client = new YouGileClient(config, new RateLimiter(config.rateLimitPerMin), hangingFetch);
    const server = createServer(config, { client });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'cancel', version: '0.0.0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);

    const ac = new AbortController();
    const pending = mcp.callTool({ name: tool, arguments: args }, undefined, { signal: ac.signal });
    pending.catch(() => undefined);
    await fetchStarted;
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchSignal?.aborted, `${tool} did not abort its HTTP request`).toBe(true);
  });
});
