import { z } from 'zod';
import { toToolError } from '../http/errors.js';
import { Id, type ToolDeps, type ToolGroup } from './_shared.js';

// Spec WebhookDto event: "<object>-<event>" or a JS regexp such as `task-*` / `.*`.
const WebhookEvent = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => {
    try {
      new RegExp(value);
      return true;
    } catch {
      return false;
    }
  }, 'event must be a valid JavaScript regexp');
const WebhookUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'url must start with https://');
// Spec WebhookFilters: {name, value: string[]}; spec examples show a plain string for title/chat_message (unverified live).
const WebhookFilter = z.object({
  name: z.enum(['location', 'title', 'chat_message']),
  value: z.array(z.string()),
});

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
const UPDATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true } as const;

function strip(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function ok(result: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

export const registerWebhooksTools: ToolGroup = (server, deps: ToolDeps) => {
  const { client, config } = deps;

  const run =
    <A>(fn: (args: A, signal: AbortSignal) => Promise<Record<string, unknown>>) =>
    async (args: A, extra: { signal: AbortSignal }) => {
      try {
        return ok(await fn(args, extra.signal));
      } catch (e) {
        return toToolError(e, config.apiKey);
      }
    };

  server.registerTool(
    'yougile_list_webhooks',
    {
      description:
        'List webhook subscriptions (the endpoint has no paging, the full list is returned). GET /webhooks.',
      inputSchema: { includeDeleted: z.boolean().default(false) },
      annotations: READ,
    },
    run(async (a: { includeDeleted: boolean }, signal) => {
      const res = await client.request<unknown>('GET', '/webhooks', {
        query: a.includeDeleted ? { includeDeleted: true } : undefined,
        signal,
      });
      // The spec types the 200 body as a single WebhookDto but the endpoint lists all subscriptions.
      const items = Array.isArray(res) ? res : res == null ? [] : [res];
      return { items, count: items.length };
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      'yougile_create_webhook',
      {
        description:
          'Create a webhook subscription. The server never receives webhooks itself (stdio); this only manages subscriptions. event is "<object>-<event>" (objects: project, board, column, task, sticker, department, group_chat, chat_message; events: created, deleted, restored, moved, renamed, updated) or a regexp like task-*. filters default to []. POST /webhooks.',
        inputSchema: {
          url: WebhookUrl,
          event: WebhookEvent,
          filters: z.array(WebhookFilter).default([]),
        },
        annotations: CREATE,
      },
      run(
        async (
          a: { url: string; event: string; filters: z.infer<typeof WebhookFilter>[] },
          signal,
        ) => {
          const res = await client.request<{ id: string }>('POST', '/webhooks', {
            body: { url: a.url, event: a.event, filters: a.filters },
            signal,
          });
          return res;
        },
      ),
    );

    server.registerTool(
      'yougile_update_webhook',
      {
        description:
          'Update a webhook subscription. Only provided fields are sent; filters, when given, REPLACES the stored list. Use disabled to pause it. PUT /webhooks/{id}.',
        inputSchema: {
          id: Id,
          url: WebhookUrl.optional(),
          event: WebhookEvent.optional(),
          filters: z.array(WebhookFilter).optional(),
          disabled: z.boolean().optional(),
        },
        annotations: UPDATE,
      },
      run(async (a: { id: string } & Record<string, unknown>, signal) => {
        const { id, ...fields } = a;
        const body = strip(fields);
        if (Object.keys(body).length === 0)
          throw new Error('Provide at least one field to update.');
        const res = await client.request<{ id: string }>(
          'PUT',
          `/webhooks/${encodeURIComponent(id)}`,
          { body, signal },
        );
        return res;
      }),
    );
  }

  if (config.allowWrites && config.allowDestructive) {
    server.registerTool(
      'yougile_delete_webhook',
      {
        description:
          'Soft-delete a webhook subscription (PUT {deleted:true}). Requires confirm: true. PUT /webhooks/{id}.',
        inputSchema: { id: Id, confirm: z.literal(true) },
        annotations: DESTROY,
      },
      run(async (a: { id: string }, signal) => {
        const res = await client.request<{ id: string }>(
          'PUT',
          `/webhooks/${encodeURIComponent(a.id)}`,
          { body: { deleted: true }, signal },
        );
        return { id: res.id, deleted: true };
      }),
    );
  }
};
