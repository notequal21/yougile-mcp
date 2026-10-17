import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import type { YouGileClient } from '../../src/http/client.js';
import { registerChatsTools, textToHtml } from '../../src/tools/chats.js';
import { registerWebhooksTools } from '../../src/tools/webhooks.js';

type Req = [string, string, { query?: unknown; body?: unknown; signal?: AbortSignal } | undefined];

async function setup(flags: { w?: boolean; d?: boolean }, reply: unknown = { id: 'x' }) {
  const request = vi.fn(async (..._a: unknown[]) => reply);
  const config = { allowWrites: !!flags.w, allowDestructive: !!flags.d } as Config;
  const server = new McpServer({ name: 't', version: '0' });
  const deps = { client: { request } as unknown as YouGileClient, config };
  registerChatsTools(server, deps);
  registerWebhooksTools(server, deps);
  const client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  // Every call must carry the MCP abort signal; assertions compare the request without it.
  const last = () => {
    const [m, p, o] = request.mock.calls.at(-1) as unknown as Req;
    expect(o?.signal).toBeInstanceOf(AbortSignal);
    const { signal: _s, ...rest } = o ?? {};
    return [m, p, o === undefined ? undefined : rest] as Req;
  };
  return { client, call, request, last };
}

describe('gating', () => {
  const names = async (f: { w?: boolean; d?: boolean }) =>
    (await (await setup(f)).client.listTools()).tools.map((t) => t.name).sort();
  it('read-only registers 5 read tools', async () => {
    expect(await names({})).toEqual([
      'yougile_get_group_chat',
      'yougile_get_message',
      'yougile_list_group_chats',
      'yougile_list_messages',
      'yougile_list_webhooks',
    ]);
  });
  it('writes add 6, destructive adds 3', async () => {
    expect(await names({ w: true })).toHaveLength(11);
    expect(await names({ w: true, d: true })).toHaveLength(14);
  });
  it('destructive without writes registers nothing extra', async () => {
    expect(await names({ d: true })).toHaveLength(5);
  });
  it('delete tools need confirm: true', async () => {
    const { call, request } = await setup({ w: true, d: true });
    for (const [n, a] of [
      ['yougile_delete_message', { chatId: 'c', id: 1 }],
      ['yougile_delete_group_chat', { id: 'c' }],
      ['yougile_delete_webhook', { id: 'w' }],
    ] as const) {
      expect((await call(n, a)).isError).toBe(true);
      expect((await call(n, { ...a, confirm: false })).isError).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
  });
});

describe('textToHtml', () => {
  it('escapes and converts newlines', () => {
    expect(textToHtml(`<b>"a" & 'b'</b>\nx\r\ny`)).toBe(
      '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;<br>x<br>y',
    );
  });
});

describe('chat reads', () => {
  it('list_group_chats maps query and paging', async () => {
    const { call, last } = await setup(
      {},
      { content: [{ id: 'a' }], paging: { count: 1, limit: 10, offset: 5, next: true } },
    );
    const r = await call('yougile_list_group_chats', { title: 'T', limit: 10, offset: 5 });
    expect(last()).toEqual([
      'GET',
      '/group-chats',
      { query: { title: 'T', limit: 10, offset: 5 } },
    ]);
    expect(r.structuredContent).toMatchObject({
      items: [{ id: 'a' }],
      paging: { next: true, nextOffset: 6 },
    });
  });
  it('list_messages sends spec query, converts ISO since, encodes chatId', async () => {
    const { call, last } = await setup({}, { content: [], paging: { next: false } });
    await call('yougile_list_messages', {
      chatId: 'a/b',
      fromUserId: 'u',
      text: 'q',
      label: 'l',
      since: '2022-01-01T00:00:00Z',
      includeSystem: true,
      includeDeleted: true,
    });
    expect(last()).toEqual([
      'GET',
      '/chats/a%2Fb/messages',
      {
        query: {
          fromUserId: 'u',
          text: 'q',
          label: 'l',
          since: 1640995200000,
          includeSystem: true,
          includeDeleted: true,
          limit: 50,
          offset: 0,
        },
      },
    ]);
  });
  it('get_message and get_group_chat paths', async () => {
    const { call, last } = await setup({}, {});
    await call('yougile_get_message', { chatId: 'c', id: '1653028146646' });
    expect(last().slice(0, 2)).toEqual(['GET', '/chats/c/messages/1653028146646']);
    expect((await call('yougile_get_message', { chatId: 'c', id: 'abc' })).isError).toBe(true);
    await call('yougile_get_group_chat', { id: 'g' });
    expect(last().slice(0, 2)).toEqual(['GET', '/group-chats/g']);
  });
});

describe('chat writes', () => {
  it('send_message defaults textHtml (escaped) and label', async () => {
    const { call, last } = await setup({ w: true }, { id: 5 });
    await call('yougile_send_message', { chatId: 'c', text: '<script>a</script>\nhi' });
    expect(last()).toEqual([
      'POST',
      '/chats/c/messages',
      {
        body: {
          text: '<script>a</script>\nhi',
          textHtml: '&lt;script&gt;a&lt;/script&gt;<br>hi',
          label: '',
        },
      },
    ]);
  });
  it('send_message honours explicit textHtml/label and bounds text', async () => {
    const { call, last } = await setup({ w: true }, { id: 5 });
    await call('yougile_send_message', {
      chatId: 'c',
      text: 't',
      textHtml: '<p>t</p>',
      label: 'L',
    });
    expect(last()[2]?.body).toEqual({ text: 't', textHtml: '<p>t</p>', label: 'L' });
    expect((await call('yougile_send_message', { chatId: 'c', text: '' })).isError).toBe(true);
    expect(
      (await call('yougile_send_message', { chatId: 'c', text: 'x'.repeat(10001) })).isError,
    ).toBe(true);
  });
  it('create_group_chat sends {} role maps by default', async () => {
    const { call, last } = await setup({ w: true });
    await call('yougile_create_group_chat', { title: 'T', users: { u: { notified: true } } });
    expect(last()).toEqual([
      'POST',
      '/group-chats',
      {
        body: { title: 'T', users: { u: { notified: true } }, userRoleMap: {}, roleConfigMap: {} },
      },
    ]);
  });
  it('update_group_chat strips undefined and rejects empty', async () => {
    const { call, last, request } = await setup({ w: true });
    await call('yougile_update_group_chat', { id: 'g', title: 'N' });
    expect(last()).toEqual(['PUT', '/group-chats/g', { body: { title: 'N' } }]);
    request.mockClear();
    expect((await call('yougile_update_group_chat', { id: 'g' })).isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
  it('update_message validates react enum', async () => {
    const { call, last, request } = await setup({ w: true }, { id: 1 });
    await call('yougile_update_message', { chatId: 'c', id: 1, react: '👍' });
    expect(last()).toEqual(['PUT', '/chats/c/messages/1', { body: { react: '👍' } }]);
    request.mockClear();
    expect(
      (await call('yougile_update_message', { chatId: 'c', id: 1, react: '🦄' })).isError,
    ).toBe(true);
    expect((await call('yougile_update_message', { chatId: 'c', id: 1 })).isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
  it('deletes send PUT {deleted:true}', async () => {
    const { call, last } = await setup({ w: true, d: true });
    await call('yougile_delete_message', { chatId: 'c', id: 7, confirm: true });
    expect(last()).toEqual(['PUT', '/chats/c/messages/7', { body: { deleted: true } }]);
    await call('yougile_delete_group_chat', { id: 'g', confirm: true });
    expect(last()).toEqual(['PUT', '/group-chats/g', { body: { deleted: true } }]);
  });
});

describe('webhooks', () => {
  it('list handles array and single object, passes includeDeleted only when true', async () => {
    const a = await setup({}, [{ id: '1' }]);
    const r = await a.call('yougile_list_webhooks', {});
    expect(a.last()).toEqual(['GET', '/webhooks', { query: undefined }]);
    expect(r.structuredContent).toEqual({ items: [{ id: '1' }], count: 1 });
    const b = await setup({}, { id: '2' });
    await b.call('yougile_list_webhooks', { includeDeleted: true });
    expect(b.last()[2]).toEqual({ query: { includeDeleted: true } });
  });
  it('create sends filters [] by default, requires https and valid event', async () => {
    const { call, last, request } = await setup({ w: true });
    await call('yougile_create_webhook', { url: 'https://h.example/x', event: 'task-*' });
    expect(last()).toEqual([
      'POST',
      '/webhooks',
      { body: { url: 'https://h.example/x', event: 'task-*', filters: [] } },
    ]);
    request.mockClear();
    for (const bad of [
      { url: 'http://h.example', event: 'task-created' },
      { url: 'https://h.example', event: '[' },
      { url: 'https://h.example', event: 'task-created', filters: [{ name: 'x', value: [] }] },
    ]) {
      expect((await call('yougile_create_webhook', bad)).isError).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('update sends only provided keys; rejects empty; delete is soft', async () => {
    const { call, last } = await setup({ w: true, d: true });
    await call('yougile_update_webhook', {
      id: 'w',
      disabled: true,
      filters: [{ name: 'title', value: ['^!'] }],
    });
    expect(last()).toEqual([
      'PUT',
      '/webhooks/w',
      { body: { disabled: true, filters: [{ name: 'title', value: ['^!'] }] } },
    ]);
    expect((await call('yougile_update_webhook', { id: 'w' })).isError).toBe(true);
    await call('yougile_delete_webhook', { id: 'w', confirm: true });
    expect(last()).toEqual(['PUT', '/webhooks/w', { body: { deleted: true } }]);
  });
});

describe('cancellation', () => {
  it('forwards the MCP signal to every tool and aborts a pending request', async () => {
    const { client, request } = await setup({ w: true, d: true });
    const calls: [string, Record<string, unknown>][] = [
      ['yougile_list_group_chats', {}],
      ['yougile_get_group_chat', { id: 'g' }],
      ['yougile_list_messages', { chatId: 'c' }],
      ['yougile_get_message', { chatId: 'c', id: 1 }],
      ['yougile_create_group_chat', { title: 'T', users: {} }],
      ['yougile_update_group_chat', { id: 'g', title: 'N' }],
      ['yougile_send_message', { chatId: 'c', text: 't' }],
      ['yougile_update_message', { chatId: 'c', id: 1, label: 'l' }],
      ['yougile_delete_message', { chatId: 'c', id: 1, confirm: true }],
      ['yougile_delete_group_chat', { id: 'g', confirm: true }],
      ['yougile_list_webhooks', {}],
      ['yougile_create_webhook', { url: 'https://h.example', event: 'task-*' }],
      ['yougile_update_webhook', { id: 'w', disabled: true }],
      ['yougile_delete_webhook', { id: 'w', confirm: true }],
    ];
    // Mock honours the signal like the real client does.
    request.mockImplementation(
      (async (...a: unknown[]) =>
        new Promise((_, reject) => {
          const sig = (a[2] as { signal?: AbortSignal }).signal!;
          sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })) as never,
    );
    for (const [name, args] of calls) {
      request.mockClear();
      const ac = new AbortController();
      const p = client.callTool({ name, arguments: args }, undefined, { signal: ac.signal });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      const sig = (request.mock.calls[0] as unknown as Req)[2]?.signal;
      expect(sig?.aborted).toBe(false);
      ac.abort();
      await expect(p).rejects.toThrow();
      expect(sig?.aborted).toBe(true);
    }
  });
});
