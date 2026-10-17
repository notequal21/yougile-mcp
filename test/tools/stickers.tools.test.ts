import { afterEach, describe, expect, it } from 'vitest';
import { registerStickersTools } from '../../src/tools/stickers.js';
import { connect } from './taskStickerHarness.js';

let open: Awaited<ReturnType<typeof connect>> | undefined;
async function setup(script: unknown[] = [], cfg = { allowWrites: true, allowDestructive: true }) {
  open = await connect(registerStickersTools, cfg, script);
  return open;
}
afterEach(async () => {
  await open?.mcp.close();
  open = undefined;
});

describe('sticker gating', () => {
  it('read-only, write and destructive sets', async () => {
    let h = await setup([], { allowWrites: false, allowDestructive: false });
    expect(await h.toolNames()).toEqual(['yougile_get_sticker', 'yougile_list_stickers']);
    await h.mcp.close();
    h = await setup([], { allowWrites: true, allowDestructive: false });
    expect(await h.toolNames()).toEqual([
      'yougile_create_sticker',
      'yougile_create_sticker_state',
      'yougile_get_sticker',
      'yougile_list_stickers',
      'yougile_update_sticker',
      'yougile_update_sticker_state',
    ]);
    await h.mcp.close();
    h = await setup();
    expect(await h.toolNames()).toHaveLength(8);
    expect(await h.toolNames()).toEqual(
      expect.arrayContaining(['yougile_delete_sticker', 'yougile_delete_sticker_state']),
    );
  });
});

describe('reads', () => {
  it.each([
    ['string', '/string-stickers'],
    ['sprint', '/sprint-stickers'],
  ])('list_stickers (%s) hits %s with filters', async (kind, path) => {
    const h = await setup([
      {
        content: [{ id: 's', name: 'n', states: [] }],
        paging: { count: 1, limit: 20, offset: 0, next: false },
      },
    ]);
    const r = await h.call('yougile_list_stickers', { kind, boardId: 'b', name: 'n', limit: 20 });
    expect(h.calls[0]).toMatchObject({
      method: 'GET',
      path,
      query: { boardId: 'b', name: 'n', limit: 20, offset: 0 },
    });
    expect(r.structuredContent.items).toHaveLength(1);
    expect(r.structuredContent.paging.nextOffset).toBeNull();
  });

  it('get_sticker', async () => {
    const h = await setup([{ id: 's', name: 'n' }]);
    await h.call('yougile_get_sticker', { kind: 'sprint', id: 's' });
    expect(h.calls[0]).toMatchObject({ method: 'GET', path: '/sprint-stickers/s' });
  });
});

describe('create / update', () => {
  it('creates a string sticker with states', async () => {
    const h = await setup([{ id: 's' }]);
    await h.call('yougile_create_sticker', {
      kind: 'string',
      name: 'Prio',
      icon: 'flag',
      states: [{ name: 'High', color: '#f00' }],
    });
    expect(h.calls[0]).toMatchObject({
      method: 'POST',
      path: '/string-stickers',
      body: { name: 'Prio', icon: 'flag', states: [{ name: 'High', color: '#f00' }] },
    });
  });

  it('creates a sprint sticker converting ISO dates', async () => {
    const h = await setup([{ id: 's' }]);
    await h.call('yougile_create_sticker', {
      kind: 'sprint',
      name: 'Sprints',
      states: [{ name: 'S1', begin: '1970-01-01T00:00:01Z', end: 5000 }],
    });
    expect(h.calls[0]).toMatchObject({
      path: '/sprint-stickers',
      body: { name: 'Sprints', states: [{ name: 'S1', begin: 1, end: 5000 }] },
    });
  });

  it('rejects fields of the other kind and invalid icons without any request', async () => {
    const h = await setup();
    const a = await h.call('yougile_create_sticker', { kind: 'sprint', name: 'x', icon: 'flag' });
    const b = await h.call('yougile_create_sticker', {
      kind: 'string',
      name: 'x',
      states: [{ name: 's', begin: 1 }],
    });
    const c = await h.call('yougile_create_sticker', { kind: 'string', name: 'x', icon: 'nope' });
    expect([a.isError, b.isError, c.isError]).toEqual([true, true, true]);
    expect(h.calls).toHaveLength(0);
  });

  it('update_sticker sends only provided keys and rejects empty updates', async () => {
    const h = await setup([{ id: 's' }]);
    const empty = await h.call('yougile_update_sticker', { kind: 'string', id: 's' });
    expect(empty.isError).toBe(true);
    await h.call('yougile_update_sticker', { kind: 'string', id: 's', name: 'N' });
    expect(h.calls).toEqual([
      {
        method: 'PUT',
        path: '/string-stickers/s',
        query: undefined,
        body: { name: 'N' },
        idempotent: undefined,
      },
    ]);
    const sprintIcon = await h.call('yougile_update_sticker', {
      kind: 'sprint',
      id: 's',
      icon: 'star',
    });
    expect(sprintIcon.isError).toBe(true);
  });

  it('create_sticker_state / update_sticker_state map to nested state paths', async () => {
    const h = await setup([{ id: 'abc123abc123' }, { id: 'abc123abc123' }]);
    await h.call('yougile_create_sticker_state', {
      kind: 'string',
      stickerId: 's',
      name: 'Done',
      color: 'green',
    });
    await h.call('yougile_update_sticker_state', {
      kind: 'sprint',
      stickerId: 's',
      stateId: 'abc123abc123',
      end: '1970-01-01T00:00:02Z',
    });
    expect(h.calls[0]).toMatchObject({
      method: 'POST',
      path: '/string-stickers/s/states',
      body: { name: 'Done', color: 'green' },
    });
    expect(h.calls[1]).toMatchObject({
      method: 'PUT',
      path: '/sprint-stickers/s/states/abc123abc123',
      body: { end: 2 },
    });
    const bad = await h.call('yougile_create_sticker_state', {
      kind: 'sprint',
      stickerId: 's',
      name: 'x',
      color: 'red',
    });
    expect(bad.isError).toBe(true);
  });
});

describe('soft deletes', () => {
  it('require confirm and send PUT deleted:true', async () => {
    const h = await setup([{ id: 's' }, { id: 'st' }]);
    expect((await h.call('yougile_delete_sticker', { kind: 'string', id: 's' })).isError).toBe(
      true,
    );
    expect(
      (
        await h.call('yougile_delete_sticker_state', {
          kind: 'string',
          stickerId: 's',
          stateId: 'x',
          confirm: false,
        })
      ).isError,
    ).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.call('yougile_delete_sticker', { kind: 'string', id: 's', confirm: true });
    await h.call('yougile_delete_sticker_state', {
      kind: 'sprint',
      stickerId: 's',
      stateId: 'st',
      confirm: true,
    });
    expect(h.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/string-stickers/s',
      body: { deleted: true },
    });
    expect(h.calls[1]).toMatchObject({
      method: 'PUT',
      path: '/sprint-stickers/s/states/st',
      body: { deleted: true },
    });
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
