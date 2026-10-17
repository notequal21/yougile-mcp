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

export const registerUsersTools: ToolGroup = (server, deps) => {
  const { client } = deps;

  defineGated(
    server,
    deps,
    'read',
    'yougile_whoami',
    {
      title: 'Who am I',
      description: 'Return the YouGile user that owns the configured API key.',
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    async (_args, extra) => ok(await client.request('GET', '/users/me', { signal: extra.signal })),
  );

  defineGated(
    server,
    deps,
    'read',
    'yougile_list_users',
    {
      title: 'List users',
      description: 'List company users, optionally filtered by email or project membership.',
      inputSchema: {
        email: z.string().optional(),
        projectId: Id.optional(),
        limit: Limit,
        offset: Offset,
      },
      annotations: ANNOTATIONS.read,
    },
    async ({ email, projectId, limit, offset }, extra) => {
      const raw = await client.request<Parameters<typeof listResult>[0]>('GET', '/users', {
        query: { email, projectId, limit, offset },
        signal: extra.signal,
      });
      return ok(listResult(raw, limit, offset));
    },
  );

  defineGated(
    server,
    deps,
    'read',
    'yougile_get_user',
    {
      title: 'Get user',
      description: 'Get one user by id.',
      inputSchema: { id: Id },
      annotations: ANNOTATIONS.read,
    },
    async ({ id }, extra) =>
      ok(await client.request('GET', `/users/${seg(id)}`, { signal: extra.signal })),
  );

  defineGated(
    server,
    deps,
    'write',
    'yougile_invite_user',
    {
      title: 'Invite user',
      description: 'Invite a user to the company by email.',
      inputSchema: {
        email: z.string().email(),
        isAdmin: z.boolean().optional(),
        messengerOnly: z.boolean().optional(),
      },
      annotations: ANNOTATIONS.create,
    },
    async (args, extra) =>
      ok(
        await client.request('POST', '/users', {
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
    'yougile_update_user',
    {
      title: 'Update user',
      description: 'Change user flags. Provide at least one of isAdmin, messengerOnly.',
      inputSchema: {
        id: Id,
        isAdmin: z.boolean().optional(),
        messengerOnly: z.boolean().optional(),
      },
      annotations: ANNOTATIONS.update,
    },
    async ({ id, ...rest }, extra) => {
      const body = stripUndefined(rest);
      if (Object.keys(body).length === 0) return localError('provide at least one field to update');
      return ok(await client.request('PUT', `/users/${seg(id)}`, { body, signal: extra.signal }));
    },
  );

  defineGated(
    server,
    deps,
    'destructive',
    'yougile_remove_user',
    {
      title: 'Remove user',
      description: 'Remove a user from the company (real HTTP DELETE, not a soft delete).',
      inputSchema: { id: Id, confirm: z.literal(true) },
      annotations: ANNOTATIONS.destructive,
    },
    async ({ id }, extra) =>
      ok(await client.request('DELETE', `/users/${seg(id)}`, { signal: extra.signal })),
  );
};
