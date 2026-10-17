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

const Members = z
  .record(Id, z.string())
  .describe('userId -> "worker" | "admin" | "observer" | roleId');

// Restore PUT paths for every soft-deletable kind (all exist in the OpenAPI spec).
const RESTORE_PATHS = {
  task: '/tasks',
  board: '/boards',
  column: '/columns',
  project: '/projects',
  department: '/departments',
  group_chat: '/group-chats',
  string_sticker: '/string-stickers',
  sprint_sticker: '/sprint-stickers',
} as const;

export const registerProjectsTools: ToolGroup = (server, deps) => {
  const { client } = deps;

  defineGated(
    server,
    deps,
    'read',
    'yougile_list_projects',
    {
      title: 'List projects',
      description: 'List projects, optionally filtered by title.',
      inputSchema: {
        title: z.string().optional(),
        includeDeleted: IncDel,
        limit: Limit,
        offset: Offset,
      },
      annotations: ANNOTATIONS.read,
    },
    async ({ title, includeDeleted, limit, offset }, extra) => {
      const raw = await client.request<Parameters<typeof listResult>[0]>('GET', '/projects', {
        query: { title, includeDeleted, limit, offset },
        signal: extra.signal,
      });
      return ok(listResult(raw, limit, offset));
    },
  );

  defineGated(
    server,
    deps,
    'read',
    'yougile_get_project',
    {
      title: 'Get project',
      description: 'Get one project by id.',
      inputSchema: { id: Id },
      annotations: ANNOTATIONS.read,
    },
    async ({ id }, extra) =>
      ok(await client.request('GET', `/projects/${seg(id)}`, { signal: extra.signal })),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_create_project',
    {
      title: 'Create project',
      description: 'Create a project, optionally with members (users) and departments.',
      inputSchema: {
        title: z.string().min(1),
        users: Members.optional(),
        departments: Members.optional(),
      },
      annotations: ANNOTATIONS.create,
    },
    async (args, extra) =>
      ok(
        await client.request('POST', '/projects', {
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
    'yougile_update_project',
    {
      title: 'Update project',
      description:
        'Update a project. Provide at least one of title, users, departments. `users` and `departments` REPLACE the whole membership map.',
      inputSchema: {
        id: Id,
        title: z.string().min(1).optional(),
        users: Members.optional(),
        departments: Members.optional(),
      },
      annotations: ANNOTATIONS.update,
    },
    async ({ id, ...rest }, extra) => {
      const body = stripUndefined(rest);
      if (Object.keys(body).length === 0) return localError('provide at least one field to update');
      return ok(
        await client.request('PUT', `/projects/${seg(id)}`, { body, signal: extra.signal }),
      );
    },
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_restore',
    {
      title: 'Restore deleted object',
      description:
        'Undo a soft delete (sets deleted=false) for a task, board, column, project, department, group chat or sticker.',
      inputSchema: {
        kind: z.enum(
          Object.keys(RESTORE_PATHS) as [
            keyof typeof RESTORE_PATHS,
            ...(keyof typeof RESTORE_PATHS)[],
          ],
        ),
        id: Id,
      },
      annotations: ANNOTATIONS.update,
    },
    async ({ kind, id }, extra) =>
      ok(
        await client.request('PUT', `${RESTORE_PATHS[kind]}/${seg(id)}`, {
          body: { deleted: false },
          signal: extra.signal,
        }),
      ),
  );

  defineGated(
    server,
    deps,
    'destructive',
    'yougile_delete_project',
    {
      title: 'Delete project',
      description: 'Soft-delete a project (PUT deleted=true). Undo with yougile_restore.',
      inputSchema: { id: Id, confirm: z.literal(true) },
      annotations: ANNOTATIONS.destructive,
    },
    async ({ id }, extra) =>
      ok(
        await client.request('PUT', `/projects/${seg(id)}`, {
          body: { deleted: true },
          signal: extra.signal,
        }),
      ),
  );
};
