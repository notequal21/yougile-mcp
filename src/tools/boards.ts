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

const BoardStickers = z.object({
  timer: z.boolean().optional(),
  deadline: z.boolean().optional(),
  stopwatch: z.boolean().optional(),
  timeTracking: z.boolean().optional(),
  assignee: z.boolean().optional(),
  repeat: z.boolean().optional(),
  custom: z.record(Id, z.boolean()).optional(),
});

export const registerBoardsTools: ToolGroup = (server, deps) => {
  const { client } = deps;

  defineGated(
    server,
    deps,
    'read',
    'yougile_list_boards',
    {
      title: 'List boards',
      description: 'List boards, optionally filtered by project or title.',
      inputSchema: {
        projectId: Id.optional(),
        title: z.string().optional(),
        includeDeleted: IncDel,
        limit: Limit,
        offset: Offset,
      },
      annotations: ANNOTATIONS.read,
    },
    async ({ projectId, title, includeDeleted, limit, offset }, extra) => {
      const raw = await client.request<Parameters<typeof listResult>[0]>('GET', '/boards', {
        query: { projectId, title, includeDeleted, limit, offset },
        signal: extra.signal,
      });
      return ok(listResult(raw, limit, offset));
    },
  );

  defineGated(
    server,
    deps,
    'read',
    'yougile_get_board',
    {
      title: 'Get board',
      description: 'Get one board by id.',
      inputSchema: { id: Id },
      annotations: ANNOTATIONS.read,
    },
    async ({ id }, extra) =>
      ok(await client.request('GET', `/boards/${seg(id)}`, { signal: extra.signal })),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_create_board',
    {
      title: 'Create board',
      description: 'Create a board in a project, optionally enabling built-in stickers.',
      inputSchema: { title: z.string().min(1), projectId: Id, stickers: BoardStickers.optional() },
      annotations: ANNOTATIONS.create,
    },
    async (args, extra) =>
      ok(
        await client.request('POST', '/boards', {
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
    'yougile_update_board',
    {
      title: 'Update board',
      description:
        'Update a board. Provide at least one of title, projectId (moves the board), stickers.',
      inputSchema: {
        id: Id,
        title: z.string().min(1).optional(),
        projectId: Id.optional(),
        stickers: BoardStickers.optional(),
      },
      annotations: ANNOTATIONS.update,
    },
    async ({ id, ...rest }, extra) => {
      const body = stripUndefined(rest);
      if (Object.keys(body).length === 0) return localError('provide at least one field to update');
      return ok(await client.request('PUT', `/boards/${seg(id)}`, { body, signal: extra.signal }));
    },
  );

  defineGated(
    server,
    deps,
    'destructive',
    'yougile_delete_board',
    {
      title: 'Delete board',
      description: 'Soft-delete a board (PUT deleted=true). Undo with yougile_restore.',
      inputSchema: { id: Id, confirm: z.literal(true) },
      annotations: ANNOTATIONS.destructive,
    },
    async ({ id }, extra) =>
      ok(
        await client.request('PUT', `/boards/${seg(id)}`, {
          body: { deleted: true },
          signal: extra.signal,
        }),
      ),
  );
};
