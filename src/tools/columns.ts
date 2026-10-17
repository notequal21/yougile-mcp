import { z } from 'zod';
import {
  ANNOTATIONS,
  defineGated,
  listResult,
  localError,
  newIdempotencyKey,
  ok,
  seg,
  stripUndefined,
} from './_structureKit.js';
import { Id, IncDel, Limit, Offset, type ToolGroup } from './_shared.js';

const Color = z.number().int().min(1).max(16);

export const registerColumnsTools: ToolGroup = (server, deps) => {
  const { client } = deps;

  defineGated(
    server,
    deps,
    'read',
    'yougile_list_columns',
    {
      title: 'List columns',
      description: 'List columns, optionally filtered by board or title.',
      inputSchema: {
        boardId: Id.optional(),
        title: z.string().optional(),
        includeDeleted: IncDel,
        limit: Limit,
        offset: Offset,
      },
      annotations: ANNOTATIONS.read,
    },
    async ({ boardId, title, includeDeleted, limit, offset }, extra) => {
      const raw = await client.request<Parameters<typeof listResult>[0]>('GET', '/columns', {
        query: { boardId, title, includeDeleted, limit, offset },
        signal: extra.signal,
      });
      return ok(listResult(raw, limit, offset));
    },
  );

  defineGated(
    server,
    deps,
    'read',
    'yougile_get_column',
    {
      title: 'Get column',
      description: 'Get one column by id.',
      inputSchema: { id: Id },
      annotations: ANNOTATIONS.read,
    },
    async ({ id }, extra) =>
      ok(await client.request('GET', `/columns/${seg(id)}`, { signal: extra.signal })),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_create_column',
    {
      title: 'Create column',
      description: 'Create a column on a board. color is an integer 1..16.',
      inputSchema: { title: z.string().min(1), boardId: Id, color: Color.optional() },
      annotations: ANNOTATIONS.create,
    },
    async (args, extra) =>
      ok(
        await client.request('POST', '/columns', {
          body: { ...stripUndefined(args), idempotencyKey: newIdempotencyKey() },
          idempotent: true,
          signal: extra.signal,
        }),
      ),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_update_column',
    {
      title: 'Update column',
      description:
        'Update a column. Provide at least one of title, color (1..16), boardId (moves the column).',
      inputSchema: {
        id: Id,
        title: z.string().min(1).optional(),
        color: Color.optional(),
        boardId: Id.optional(),
      },
      annotations: ANNOTATIONS.update,
    },
    async ({ id, ...rest }, extra) => {
      const body = stripUndefined(rest);
      if (Object.keys(body).length === 0) return localError('provide at least one field to update');
      return ok(await client.request('PUT', `/columns/${seg(id)}`, { body, signal: extra.signal }));
    },
  );

  defineGated(
    server,
    deps,
    'destructive',
    'yougile_delete_column',
    {
      title: 'Delete column',
      description: 'Soft-delete a column (PUT deleted=true). Undo with yougile_restore.',
      inputSchema: { id: Id, confirm: z.literal(true) },
      annotations: ANNOTATIONS.destructive,
    },
    async ({ id }, extra) =>
      ok(
        await client.request('PUT', `/columns/${seg(id)}`, {
          body: { deleted: true },
          signal: extra.signal,
        }),
      ),
  );
};
