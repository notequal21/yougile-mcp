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
import { Id, Limit, Offset, type ToolGroup } from './_shared.js';

const Permissions = z
  .record(z.unknown())
  .describe(
    'ProjectPermissionsDto (editTitle, delete, addBoard, boards, children). Copy the shape from yougile_get_project_role output.',
  );

export const registerRolesTools: ToolGroup = (server, deps) => {
  const { client } = deps;
  const base = (projectId: string): string => `/projects/${seg(projectId)}/roles`;

  defineGated(
    server,
    deps,
    'read',
    'yougile_list_project_roles',
    {
      title: 'List project roles',
      description: 'List roles of a project.',
      inputSchema: { projectId: Id, name: z.string().optional(), limit: Limit, offset: Offset },
      annotations: ANNOTATIONS.read,
    },
    async ({ projectId, name, limit, offset }, extra) => {
      const raw = await client.request<Parameters<typeof listResult>[0]>('GET', base(projectId), {
        query: { name, limit, offset },
        signal: extra.signal,
      });
      return ok(listResult(raw, limit, offset));
    },
  );

  defineGated(
    server,
    deps,
    'read',
    'yougile_get_project_role',
    {
      title: 'Get project role',
      description:
        'Get one project role, including its permissions (usable as a template for create).',
      inputSchema: { projectId: Id, id: Id },
      annotations: ANNOTATIONS.read,
    },
    async ({ projectId, id }, extra) =>
      ok(await client.request('GET', `${base(projectId)}/${seg(id)}`, { signal: extra.signal })),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_create_project_role',
    {
      title: 'Create project role',
      description:
        'Create a project role. Use the output of yougile_get_project_role as a template for `permissions`.',
      inputSchema: {
        projectId: Id,
        name: z.string().min(1),
        description: z.string().optional(),
        permissions: Permissions,
      },
      annotations: ANNOTATIONS.create,
    },
    async ({ projectId, ...rest }, extra) =>
      ok(
        await client.request('POST', base(projectId), {
          body: stripUndefined(rest),
          idempotent: false,
          signal: extra.signal,
        }),
      ),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_update_project_role',
    {
      title: 'Update project role',
      description: 'Update a project role. Provide at least one of name, description, permissions.',
      inputSchema: {
        projectId: Id,
        id: Id,
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        permissions: Permissions.optional(),
      },
      annotations: ANNOTATIONS.update,
    },
    async ({ projectId, id, ...rest }, extra) => {
      const body = stripUndefined(rest);
      if (Object.keys(body).length === 0) return localError('provide at least one field to update');
      return ok(
        await client.request('PUT', `${base(projectId)}/${seg(id)}`, {
          body,
          signal: extra.signal,
        }),
      );
    },
  );

  defineGated(
    server,
    deps,
    'destructive',
    'yougile_delete_project_role',
    {
      title: 'Delete project role',
      description: 'Delete a project role (real HTTP DELETE, cannot be restored).',
      inputSchema: { projectId: Id, id: Id, confirm: z.literal(true) },
      annotations: ANNOTATIONS.destructive,
    },
    async ({ projectId, id }, extra) =>
      ok(await client.request('DELETE', `${base(projectId)}/${seg(id)}`, { signal: extra.signal })),
  );
};
