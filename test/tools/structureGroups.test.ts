import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { YouGileClient } from '../../src/http/client.js';
import { registerBoardsTools } from '../../src/tools/boards.js';
import { registerColumnsTools } from '../../src/tools/columns.js';
import { registerCompanyTools } from '../../src/tools/company.js';
import { registerDepartmentsTools } from '../../src/tools/departments.js';
import { registerProjectsTools } from '../../src/tools/projects.js';
import { registerRolesTools } from '../../src/tools/roles.js';
import { registerUsersTools } from '../../src/tools/users.js';

interface Call {
  method: string;
  path: string;
  opts?: {
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    idempotent?: boolean;
    signal?: AbortSignal;
  };
}

async function setup(
  flags: { allowWrites?: boolean; allowDestructive?: boolean },
  response: unknown = { id: 'x' },
  blockOnSignal = false,
) {
  const calls: Call[] = [];
  const client = {
    request: (method: string, path: string, opts?: Call['opts']) => {
      calls.push({ method, path, opts });
      if (blockOnSignal && opts?.signal)
        return new Promise((resolve, reject) => {
          if (opts.signal!.aborted) reject(new Error('cancelled'));
          else
            opts.signal!.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            });
        });
      return Promise.resolve(response);
    },
  } as unknown as YouGileClient;
  const config = {
    apiKey: 'k',
    allowWrites: flags.allowWrites ?? false,
    allowDestructive: flags.allowDestructive ?? false,
  } as Config;
  const server = new McpServer({ name: 't', version: '0' });
  for (const reg of [
    registerUsersTools,
    registerCompanyTools,
    registerProjectsTools,
    registerRolesTools,
    registerDepartmentsTools,
    registerBoardsTools,
    registerColumnsTools,
  ])
    reg(server, { client, config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const names = async () => (await mcp.listTools()).tools.map((t) => t.name).sort();
  const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    mcp.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
  return { calls, names, call };
}

const READ = [
  'yougile_whoami',
  'yougile_list_users',
  'yougile_get_user',
  'yougile_get_company',
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
];
const WRITE = [
  'yougile_invite_user',
  'yougile_update_user',
  'yougile_create_project',
  'yougile_update_project',
  'yougile_restore',
  'yougile_create_project_role',
  'yougile_update_project_role',
  'yougile_create_department',
  'yougile_update_department',
  'yougile_create_board',
  'yougile_update_board',
  'yougile_create_column',
  'yougile_update_column',
];
const DESTRUCTIVE = [
  'yougile_remove_user',
  'yougile_delete_project',
  'yougile_delete_project_role',
  'yougile_delete_department',
  'yougile_delete_board',
  'yougile_delete_column',
];

describe('structure groups: gating', () => {
  it('registers only read tools by default', async () => {
    expect(await (await setup({})).names()).toEqual([...READ].sort());
  });
  it('adds write tools with allowWrites', async () => {
    expect(await (await setup({ allowWrites: true })).names()).toEqual([...READ, ...WRITE].sort());
  });
  it('adds destructive tools with allowDestructive', async () => {
    const s = await setup({ allowWrites: true, allowDestructive: true });
    expect(await s.names()).toEqual([...READ, ...WRITE, ...DESTRUCTIVE].sort());
  });
});

describe('structure groups: request mapping', () => {
  it('list_users passes query and wraps paging', async () => {
    const s = await setup(
      {},
      { paging: { count: 1, limit: 10, offset: 5, next: true }, content: [{ id: 'u' }] },
    );
    const r = await s.call('yougile_list_users', { email: 'a@b.c', limit: 10, offset: 5 });
    expect(s.calls[0]).toMatchObject({
      method: 'GET',
      path: '/users',
      opts: { query: { email: 'a@b.c', limit: 10, offset: 5 } },
    });
    expect(r.structuredContent).toMatchObject({
      items: [{ id: 'u' }],
      paging: { next: true, nextOffset: 6 },
    });
  });

  it('whoami / company paths', async () => {
    const s = await setup({});
    await s.call('yougile_whoami', {});
    await s.call('yougile_get_company', {});
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /users/me',
      'GET /companies',
    ]);
  });

  it('update_user strips undefined and rejects empty updates', async () => {
    const s = await setup({ allowWrites: true });
    await s.call('yougile_update_user', { id: 'u1', isAdmin: true });
    expect(s.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/users/u1',
      opts: { body: { isAdmin: true } },
    });
    expect(Object.keys(s.calls[0]!.opts!.body!)).toEqual(['isAdmin']);
    const r = await s.call('yougile_update_user', { id: 'u1' });
    expect(r.isError).toBe(true);
    expect(s.calls).toHaveLength(1);
  });

  it('create_project sends an idempotencyKey and idempotent flag', async () => {
    const s = await setup({ allowWrites: true });
    await s.call('yougile_create_project', { title: 'P', users: { u1: 'admin' } });
    const c = s.calls[0]!;
    expect(c).toMatchObject({ method: 'POST', path: '/projects', opts: { idempotent: true } });
    expect(c.opts!.body).toMatchObject({ title: 'P', users: { u1: 'admin' } });
    expect(typeof c.opts!.body!.idempotencyKey).toBe('string');
  });

  it.each([
    ['task', '/tasks/i'],
    ['board', '/boards/i'],
    ['column', '/columns/i'],
    ['project', '/projects/i'],
    ['department', '/departments/i'],
    ['group_chat', '/group-chats/i'],
    ['string_sticker', '/string-stickers/i'],
    ['sprint_sticker', '/sprint-stickers/i'],
  ])('restore %s', async (kind, path) => {
    const s = await setup({ allowWrites: true });
    await s.call('yougile_restore', { kind, id: 'i' });
    expect(s.calls[0]).toMatchObject({ method: 'PUT', path, opts: { body: { deleted: false } } });
  });

  it('destructive tools require confirm: true', async () => {
    const s = await setup({ allowWrites: true, allowDestructive: true });
    const bad = await s.call('yougile_delete_board', { id: 'b', confirm: false });
    expect(bad.isError).toBe(true);
    expect(s.calls).toHaveLength(0);
    await s.call('yougile_delete_board', { id: 'b', confirm: true });
    expect(s.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/boards/b',
      opts: { body: { deleted: true } },
    });
  });

  it('remove_user and delete_project_role use real DELETE', async () => {
    const s = await setup({ allowWrites: true, allowDestructive: true });
    await s.call('yougile_remove_user', { id: 'u', confirm: true });
    await s.call('yougile_delete_project_role', { projectId: 'p', id: 'r', confirm: true });
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /users/u',
      'DELETE /projects/p/roles/r',
    ]);
  });

  it('roles: list query, create body, update', async () => {
    const s = await setup({ allowWrites: true });
    await s.call('yougile_list_project_roles', { projectId: 'p', name: 'n' });
    await s.call('yougile_create_project_role', {
      projectId: 'p',
      name: 'R',
      permissions: { editTitle: true },
    });
    await s.call('yougile_update_project_role', { projectId: 'p', id: 'r', description: 'd' });
    expect(s.calls[0]).toMatchObject({
      method: 'GET',
      path: '/projects/p/roles',
      opts: { query: { name: 'n', limit: 50, offset: 0 } },
    });
    expect(s.calls[1]).toMatchObject({
      method: 'POST',
      path: '/projects/p/roles',
      opts: { body: { name: 'R', permissions: { editTitle: true } } },
    });
    expect(s.calls[2]).toMatchObject({
      method: 'PUT',
      path: '/projects/p/roles/r',
      opts: { body: { description: 'd' } },
    });
  });

  it('departments: create and update', async () => {
    const s = await setup({ allowWrites: true });
    await s.call('yougile_create_department', { title: 'D', parentId: 'pp' });
    await s.call('yougile_update_department', { id: 'd', users: { u: 'admin' } });
    expect(s.calls[0]).toMatchObject({
      method: 'POST',
      path: '/departments',
      opts: { body: { title: 'D', parentId: 'pp' } },
    });
    expect(s.calls[1]).toMatchObject({
      method: 'PUT',
      path: '/departments/d',
      opts: { body: { users: { u: 'admin' } } },
    });
  });

  it('boards and columns: create with idempotencyKey, validate color, move via update', async () => {
    const s = await setup({ allowWrites: true });
    await s.call('yougile_create_board', {
      title: 'B',
      projectId: 'p',
      stickers: { deadline: true, custom: { s: true } },
    });
    await s.call('yougile_create_column', { title: 'C', boardId: 'b', color: 3 });
    expect(
      await s.call('yougile_create_column', { title: 'C', boardId: 'b', color: 17 }),
    ).toMatchObject({ isError: true });
    await s.call('yougile_update_column', { id: 'c', boardId: 'b2' });
    await s.call('yougile_update_board', { id: 'b', projectId: 'p2' });
    expect(s.calls[0]!.opts!.body).toMatchObject({
      title: 'B',
      projectId: 'p',
      stickers: { deadline: true, custom: { s: true } },
    });
    expect(s.calls[0]!.opts!.body!.idempotencyKey).toBeTypeOf('string');
    expect(s.calls[1]!.opts!.body).toMatchObject({ title: 'C', boardId: 'b', color: 3 });
    expect(s.calls).toHaveLength(4);
    expect(s.calls[2]).toMatchObject({
      method: 'PUT',
      path: '/columns/c',
      opts: { body: { boardId: 'b2' } },
    });
    expect(s.calls[3]).toMatchObject({
      method: 'PUT',
      path: '/boards/b',
      opts: { body: { projectId: 'p2' } },
    });
  });

  it('list_boards / list_columns / list_departments / list_projects query mapping', async () => {
    const s = await setup({}, { paging: { limit: 50, offset: 0, next: false }, content: [] });
    await s.call('yougile_list_boards', { projectId: 'p', includeDeleted: true });
    await s.call('yougile_list_columns', { boardId: 'b' });
    await s.call('yougile_list_departments', { parentId: 'x', title: 't' });
    await s.call('yougile_list_projects', { title: 'p' });
    expect(s.calls.map((c) => c.path)).toEqual([
      '/boards',
      '/columns',
      '/departments',
      '/projects',
    ]);
    expect(s.calls[0]!.opts!.query).toMatchObject({ projectId: 'p', includeDeleted: true });
    expect(s.calls[1]!.opts!.query).toMatchObject({ boardId: 'b' });
    expect(s.calls[2]!.opts!.query).toMatchObject({ parentId: 'x', title: 't' });
  });

  it('thrown errors become sanitized isError results', async () => {
    const s = await setup({});
    const { YouGileError } = await import('../../src/http/errors.js');
    // swap in a failing request through a fresh setup
    const failing = {
      request: () => Promise.reject(new YouGileError('nope https://x.y/z?k=1', 'not_found', 404)),
    } as unknown as YouGileClient;
    const server = new McpServer({ name: 't', version: '0' });
    registerUsersTools(server, {
      client: failing,
      config: { apiKey: 'k', allowWrites: false, allowDestructive: false } as Config,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    const r = await mcp.callTool({ name: 'yougile_get_user', arguments: { id: 'u' } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('not_found');
    expect(JSON.stringify(r.content)).not.toContain('x.y');
    void s;
  });
});

describe('structure groups: cancellation', () => {
  it('propagates MCP cancellation signal to the HTTP request', async () => {
    const s = await setup({}, {}, true);
    const controller = new AbortController();
    const pending = s.call('yougile_get_user', { id: 'u' }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toThrow(/AbortError|aborted/);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.opts?.signal?.aborted).toBe(true);
  });
});
