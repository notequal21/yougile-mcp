import { z } from 'zod';
import {
  ANNOTATIONS,
  defineGated,
  listResult,
  localError,
  ok,
  seg,
  stripUndefined,
} from './_structureKit.js';
import { Id, IncDel, Limit, Offset, type ToolGroup } from './_shared.js';

const Members = z.record(Id, z.string()).describe('userId -> "worker" | "admin" | roleId');

export const registerDepartmentsTools: ToolGroup = (server, deps) => {
  const { client } = deps;

  defineGated(
    server,
    deps,
    'read',
    'yougile_list_departments',
    {
      title: 'List departments',
      description: 'List departments, optionally filtered by title or parent.',
      inputSchema: {
        title: z.string().optional(),
        parentId: Id.optional(),
        includeDeleted: IncDel,
        limit: Limit,
        offset: Offset,
      },
      annotations: ANNOTATIONS.read,
    },
    async ({ title, parentId, includeDeleted, limit, offset }, extra) => {
      const raw = await client.request<Parameters<typeof listResult>[0]>('GET', '/departments', {
        query: { title, parentId, includeDeleted, limit, offset },
        signal: extra.signal,
      });
      return ok(listResult(raw, limit, offset));
    },
  );

  defineGated(
    server,
    deps,
    'read',
    'yougile_get_department',
    {
      title: 'Get department',
      description: 'Get one department by id.',
      inputSchema: { id: Id },
      annotations: ANNOTATIONS.read,
    },
    async ({ id }, extra) =>
      ok(await client.request('GET', `/departments/${seg(id)}`, { signal: extra.signal })),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_create_department',
    {
      title: 'Create department',
      description: 'Create a department, optionally nested under parentId and with members.',
      inputSchema: { title: z.string().min(1), parentId: Id.optional(), users: Members.optional() },
      annotations: ANNOTATIONS.create,
    },
    async (args, extra) =>
      ok(
        await client.request('POST', '/departments', {
          body: stripUndefined(args),
          idempotent: false,
          signal: extra.signal,
        }),
      ),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_update_department',
    {
      title: 'Update department',
      description:
        'Update a department. Provide at least one of title, parentId, users. `users` REPLACES the member map.',
      inputSchema: {
        id: Id,
        title: z.string().min(1).optional(),
        parentId: Id.optional(),
        users: Members.optional(),
      },
      annotations: ANNOTATIONS.update,
    },
    async ({ id, ...rest }, extra) => {
      const body = stripUndefined(rest);
      if (Object.keys(body).length === 0) return localError('provide at least one field to update');
      return ok(
        await client.request('PUT', `/departments/${seg(id)}`, { body, signal: extra.signal }),
      );
    },
  );

  defineGated(
    server,
    deps,
    'destructive',
    'yougile_delete_department',
    {
      title: 'Delete department',
      description: 'Soft-delete a department (PUT deleted=true). Undo with yougile_restore.',
      inputSchema: { id: Id, confirm: z.literal(true) },
      annotations: ANNOTATIONS.destructive,
    },
    async ({ id }, extra) =>
      ok(
        await client.request('PUT', `/departments/${seg(id)}`, {
          body: { deleted: true },
          signal: extra.signal,
        }),
      ),
  );
};
