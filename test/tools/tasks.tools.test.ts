/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles patch the scripted client */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { YouGileClient } from '../../src/http/client.js';
import { RateLimiter } from '../../src/http/rateLimiter.js';
import { YouGileError } from '../../src/http/errors.js';
import { registerTasksTools } from '../../src/tools/tasks.js';
import { baseConfig, connect } from './taskStickerHarness.js';

const READS = [
  'yougile_get_task',
  'yougile_get_task_chat_subscribers',
  'yougile_get_task_log',
  'yougile_list_tasks',
];
const WRITES = [
  'yougile_create_task',
  'yougile_move_task',
  'yougile_set_task_checklists',
  'yougile_set_task_chat_subscribers',
  'yougile_set_task_subtasks',
  'yougile_update_task',
];

let open: Awaited<ReturnType<typeof connect>> | undefined;
async function setup(script: unknown[] = [], cfg = { allowWrites: true, allowDestructive: true }) {
  open = await connect(registerTasksTools, cfg, script);
  return open;
}
afterEach(async () => {
  await open?.mcp.close();
  open = undefined;
});

describe('task tool gating', () => {
  it('registers only reads by default', async () => {
    const h = await setup([], { allowWrites: false, allowDestructive: false });
    expect(await h.toolNames()).toEqual(READS);
  });
  it('adds writes but not destructive tools', async () => {
    const h = await setup([], { allowWrites: true, allowDestructive: false });
    expect(await h.toolNames()).toEqual([...READS, ...WRITES].sort());
  });
  it('adds delete_task with the destructive gate', async () => {
    const h = await setup();
    expect(await h.toolNames()).toContain('yougile_delete_task');
  });
});

describe('read tools', () => {
  it('list_tasks sends one request with filters and projects items', async () => {
    const h = await setup([
      {
        content: [
          {
            id: 't1',
            title: 'A',
            columnId: 'c',
            deadline: { deadline: 1653029146646 },
            timestamp: 1653029146646,
            description: 'big',
          },
        ],
        paging: { count: 1, limit: 10, offset: 5, next: true },
      },
    ]);
    const r = await h.call('yougile_list_tasks', {
      columnId: 'c1',
      assignedTo: ['u1', 'u2'],
      title: 'x',
      limit: 10,
      offset: 5,
    });
    expect(h.calls).toEqual([
      {
        method: 'GET',
        path: '/task-list',
        query: { columnId: 'c1', assignedTo: 'u1,u2', title: 'x', limit: 10, offset: 5 },
        body: undefined,
        idempotent: undefined,
      },
    ]);
    const item = r.structuredContent.items[0];
    expect(item.deadline).toBe(1653029146646);
    expect(item.deadlineIso).toBe('2022-05-20T06:45:46.646Z');
    expect(item.description).toBeUndefined();
    expect(r.structuredContent.paging).toMatchObject({
      next: true,
      nextOffset: 6,
      limit: 10,
      offset: 5,
    });
  });

  it('list_tasks fetchAll paginates with min(maxItems, config cap) and reports truncation', async () => {
    const h = await setup([
      { items: [{ id: 'a', title: 'a' }], count: 9, nextOffset: 1, truncated: true },
    ]);
    const r = await h.call('yougile_list_tasks', {
      fetchAll: true,
      maxItems: 5000,
      includeDeleted: true,
    });
    expect(h.calls).toHaveLength(0);
    expect(h.paginateCalls).toEqual([
      {
        path: '/task-list',
        query: { includeDeleted: true },
        opts: { offset: 0, maxItems: 500, signal: expect.any(AbortSignal) },
      },
    ]);
    expect(r.structuredContent.truncated).toBe(true);
    expect(r.structuredContent.paging.nextOffset).toBe(1);
  });

  it('get_task returns the DTO with ISO additions and encodes the id', async () => {
    const h = await setup([{ id: 'a/b', title: 'T', timestamp: 0, completedTimestamp: 1000 }]);
    const r = await h.call('yougile_get_task', { id: 'a/b' });
    expect(h.calls[0]).toMatchObject({ method: 'GET', path: '/tasks/a%2Fb' });
    expect(r.structuredContent.completedTimestampIso).toBe('1970-01-01T00:00:01.000Z');
  });

  it('get_task_log uses the before cursor and returns nextBefore only when next is true', async () => {
    const h = await setup([
      {
        content: [
          { timestamp: 300, type: 'add' },
          { timestamp: 200, type: 'move' },
        ],
        paging: { count: 2, limit: 2, next: true },
      },
      { content: [{ timestamp: 100, type: 'add' }], paging: { count: 1, limit: 2, next: false } },
    ]);
    const r1 = await h.call('yougile_get_task_log', { id: 't', limit: 2, before: 400 });
    expect(h.calls[0]).toMatchObject({ path: '/tasks/t/log', query: { limit: 2, before: 400 } });
    expect(r1.structuredContent.paging.nextBefore).toBe(200);
    const r2 = await h.call('yougile_get_task_log', { id: 't' });
    expect(h.calls[1]?.query).toEqual({ limit: 50 });
    expect(r2.structuredContent.paging.nextBefore).toBeNull();
  });

  it('get_task_chat_subscribers reads a plain string array', async () => {
    const h = await setup([['u1', 'u2']]);
    const r = await h.call('yougile_get_task_chat_subscribers', { id: 't' });
    expect(h.calls[0]).toMatchObject({ method: 'GET', path: '/tasks/t/chat-subscribers' });
    expect(r.structuredContent.subscribers).toEqual(['u1', 'u2']);
  });

  it('maps API errors to sanitized tool errors without the key', async () => {
    const h = await setup([
      new YouGileError('bad key secret-key-123 at https://yougile.com/x?k=1', 'auth', 401),
    ]);
    const r = await h.call('yougile_get_task', { id: 't' });
    expect(r.isError).toBe(true);
    const text = r.content[0]?.text ?? '';
    expect(text).toContain('auth');
    expect(text).not.toContain('secret-key-123');
    expect(text).not.toContain('yougile.com/x');
  });
});

describe('create_task', () => {
  it('sends deadline conversion, spec-required fields and an idempotency key', async () => {
    const h = await setup([{ id: 'new' }]);
    const r = await h.call('yougile_create_task', {
      title: 'T',
      columnId: 'c',
      deadline: { deadline: '2026-10-20T12:00:00Z', withTime: true },
      timeTracking: { plan: 2 },
      checklists: [{ title: 'cl', items: [{ title: 'i' }] }],
    });
    expect(r.structuredContent.id).toBe('new');
    const call = h.calls[0]!;
    expect(call).toMatchObject({ method: 'POST', path: '/tasks', idempotent: true });
    expect(call.body.deadline).toEqual({
      deadline: Date.parse('2026-10-20T12:00:00Z'),
      withTime: true,
      blockedPoints: [],
      links: [],
    });
    expect(call.body.timeTracking).toEqual({ plan: 2, work: 0 });
    expect(call.body.checklists[0].items[0]).toEqual({ title: 'i', isCompleted: false });
    expect(call.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(call.body)).not.toContain('description');
  });

  it('accepts epoch ms and rejects invalid dates and a deadline without an end date', async () => {
    const h = await setup([{ id: 'n' }]);
    await h.call('yougile_create_task', { title: 'T', deadline: { deadline: 1700000000000 } });
    expect(h.calls[0]?.body.deadline.deadline).toBe(1700000000000);
    const bad = await h.call('yougile_create_task', {
      title: 'T',
      deadline: { deadline: 'not a date' },
    });
    expect(bad.isError).toBe(true);
    const noEnd = await h.call('yougile_create_task', { title: 'T', deadline: { startDate: 1 } });
    expect(noEnd.isError).toBe(true);
    expect(h.calls).toHaveLength(1);
  });
});

describe('update_task', () => {
  it('rejects empty updates locally', async () => {
    const h = await setup();
    const r = await h.call('yougile_update_task', { id: 't' });
    expect(r.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it('sends only provided keys, including columnId "-"', async () => {
    const h = await setup([{ id: 't' }]);
    await h.call('yougile_update_task', { id: 't', columnId: '-', completed: false });
    expect(h.calls).toEqual([
      {
        method: 'PUT',
        path: '/tasks/t',
        query: undefined,
        body: { columnId: '-', completed: false },
        idempotent: undefined,
      },
    ]);
  });

  it('deadline null sends deleted with spec-required arrays and does not read first', async () => {
    const h = await setup([{ id: 't' }]);
    await h.call('yougile_update_task', { id: 't', deadline: null, timeTracking: null });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.body).toEqual({
      deadline: { deleted: true, blockedPoints: [], links: [] },
      timeTracking: { deleted: true },
    });
  });

  it('deadline object merges into the stored sticker, keeping blocked points and links', async () => {
    const h = await setup([
      {
        id: 't',
        deadline: {
          deadline: 10,
          startDate: 5,
          withTime: false,
          blockedPoints: ['start'],
          links: ['t2'],
        },
      },
      { id: 't' },
    ]);
    await h.call('yougile_update_task', {
      id: 't',
      deadline: { deadline: '1970-01-01T00:00:00.100Z' },
    });
    expect(h.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(h.calls[1]?.body.deadline).toEqual({
      deadline: 100,
      startDate: 5,
      withTime: false,
      blockedPoints: ['start'],
      links: ['t2'],
    });
  });

  it('partial timeTracking is completed from the stored value', async () => {
    const h = await setup([{ id: 't', timeTracking: { plan: 4, work: 1 } }, { id: 't' }]);
    await h.call('yougile_update_task', { id: 't', timeTracking: { work: 3 } });
    expect(h.calls[1]?.body.timeTracking).toEqual({ plan: 4, work: 3 });
  });

  it('move_task puts only the column', async () => {
    const h = await setup([{ id: 't' }]);
    await h.call('yougile_move_task', { id: 't', columnId: 'c9' });
    expect(h.calls[0]).toMatchObject({ method: 'PUT', path: '/tasks/t', body: { columnId: 'c9' } });
  });
});

describe('read-modify-write tools', () => {
  it('checklists append reads, then writes existing + new', async () => {
    const h = await setup([
      {
        id: 't',
        checklists: [{ title: 'old', items: [{ title: 'a', isCompleted: true, extra: 1 }] }],
      },
      { id: 't' },
    ]);
    const r = await h.call('yougile_set_task_checklists', {
      id: 't',
      checklists: [{ title: 'new', items: [{ title: 'b' }] }],
    });
    expect(h.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(h.calls[1]?.body).toEqual({
      checklists: [
        { title: 'old', items: [{ title: 'a', isCompleted: true }] },
        { title: 'new', items: [{ title: 'b', isCompleted: false }] },
      ],
    });
    expect(r.structuredContent.checklists).toHaveLength(2);
  });

  it('checklists replace writes without reading', async () => {
    const h = await setup([{ id: 't' }]);
    await h.call('yougile_set_task_checklists', { id: 't', mode: 'replace', checklists: [] });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.body).toEqual({ checklists: [] });
  });

  it('subtasks add dedupes, remove filters, replace overwrites', async () => {
    const h = await setup([
      { id: 't', subtasks: ['a', 'b'] },
      { id: 't' },
      { id: 't', subtasks: ['a', 'b', 'c'] },
      { id: 't' },
      { id: 't' },
    ]);
    await h.call('yougile_set_task_subtasks', { id: 't', subtasks: ['b', 'c'] });
    expect(h.calls[1]?.body).toEqual({ subtasks: ['a', 'b', 'c'] });
    await h.call('yougile_set_task_subtasks', { id: 't', subtasks: ['a'], mode: 'remove' });
    expect(h.calls[3]?.body).toEqual({ subtasks: ['b', 'c'] });
    await h.call('yougile_set_task_subtasks', { id: 't', subtasks: ['z'], mode: 'replace' });
    expect(h.calls[4]?.body).toEqual({ subtasks: ['z'] });
  });

  it('subtasks no-op sends no PUT', async () => {
    const h = await setup([{ id: 't', subtasks: ['a'] }]);
    const r = await h.call('yougile_set_task_subtasks', { id: 't', subtasks: ['a'] });
    expect(h.calls).toHaveLength(1);
    expect(r.structuredContent.unchanged).toBe(true);
  });

  it('chat subscribers body is { content: ids }', async () => {
    const h = await setup([{ id: 't' }]);
    await h.call('yougile_set_task_chat_subscribers', { id: 't', users: ['u1'] });
    expect(h.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/tasks/t/chat-subscribers',
      body: { content: ['u1'] },
    });
  });
});

describe('delete_task', () => {
  it('requires confirm:true and soft-deletes with PUT', async () => {
    const h = await setup([{ id: 't' }]);
    const bad = await h.call('yougile_delete_task', { id: 't' });
    expect(bad.isError).toBe(true);
    const bad2 = await h.call('yougile_delete_task', { id: 't', confirm: false });
    expect(bad2.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.call('yougile_delete_task', { id: 't', confirm: true });
    expect(h.calls[0]).toMatchObject({ method: 'PUT', path: '/tasks/t', body: { deleted: true } });
  });
});

describe('cancellation', () => {
  it('passes the MCP request signal to paginate and to every request', async () => {
    const h = await setup([
      { items: [], nextOffset: null, truncated: false },
      { id: 't', subtasks: [] },
      { id: 't' },
    ]);
    await h.call('yougile_list_tasks', { fetchAll: true });
    expect(h.paginateCalls[0]?.opts.signal).toBeInstanceOf(AbortSignal);
    await h.call('yougile_set_task_subtasks', { id: 't', subtasks: ['a'] });
    expect(h.signals).toHaveLength(2);
    expect(h.signals.every((sig) => sig instanceof AbortSignal)).toBe(true);
  });

  it('aborts an in-flight fetchAll through the real client when the MCP call is cancelled', async () => {
    const config = { ...baseConfig, allowWrites: false };
    let fetchSignal: AbortSignal | undefined;
    const hangingFetch = ((_url: unknown, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch;
    const server = new McpServer({ name: 't', version: '0' });
    registerTasksTools(server, {
      client: new YouGileClient(config, new RateLimiter(config.rateLimitPerMin), hangingFetch),
      config,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    const ac = new AbortController();
    const pending = mcp.callTool(
      { name: 'yougile_list_tasks', arguments: { fetchAll: true } },
      undefined,
      {
        signal: ac.signal,
      },
    );
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    ac.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(fetchSignal?.aborted).toBe(true));
    await mcp.close();
  });
});

describe('create_task idempotency', () => {
  it('uses the same key in the body and the request option', async () => {
    const h = await setup([{ id: 'n' }]);
    await h.call('yougile_create_task', { title: 'T' });
    expect(h.calls[0]?.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('per-tool shared deadline', () => {
  it('uses one signal for GET and PUT, and cancellation aborts the second request without a write', async () => {
    const h = await setup([{ id: 't1', subtasks: [] }]);
    // Replace the scripted client's PUT with one that hangs until the shared signal aborts.
    const original = (h.client as any).request.bind(h.client);
    (h.client as any).request = async (method: string, path: string, opts: any = {}) => {
      if (method !== 'PUT') return original(method, path, opts);
      h.calls.push({ method, path, body: opts.body });
      h.signals.push(opts.signal);
      await new Promise((_, reject) =>
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    };
    const ctl = new AbortController();
    const pending = h.mcp
      .callTool(
        { name: 'yougile_set_task_subtasks', arguments: { id: 't1', subtasks: ['s1'] } },
        undefined,
        { signal: ctl.signal },
      )
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(h.calls.map((c) => c.method)).toEqual(['GET', 'PUT']));
    expect(h.signals[0]).toBeDefined();
    expect(h.signals[1]).toBe(h.signals[0]);
    expect(h.signals[0]!.aborted).toBe(false);
    ctl.abort();
    await pending;
    await vi.waitFor(() => expect(h.signals[1]!.aborted).toBe(true));
    expect(h.calls).toHaveLength(2);
  });
});
