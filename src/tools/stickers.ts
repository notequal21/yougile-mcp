import { z } from 'zod';
import { toToolError } from '../http/errors.js';
import { EpochMs, Id, IncDel, Limit, Offset, type ToolGroup } from './_shared.js';
import {
  CREATE,
  READ,
  REMOVE,
  UPDATE,
  encodeId,
  localError,
  pagingOf,
  stripUndefined,
  toolResult,
} from './tasks.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const EpochSeconds = z.union([
  z.number().int().min(0),
  EpochMs.pipe(z.number().transform((ms) => Math.floor(ms / 1000))),
]);

// Icons accepted by the spec (CreateStringStickerDto / UpdateStringStickerDto).
const ICONS = [
  '',
  'star',
  'heart',
  'check',
  'cloud',
  'filter',
  'alarm',
  'bolt',
  'bookmark',
  'box',
  'bulb',
  'prio',
  'code',
  'ruble',
  'dollar',
  'euro',
  'eye',
  'flag',
  'flame',
  'history',
  'info',
  'key',
  'anchor',
  'message',
  'movie',
  'mnote',
  'pencil',
  'picture',
  'pin',
  'clockwise',
  'clockwiseDot',
  'rectangle',
  'shield',
  'stack',
  'string',
  'timeStop',
  'design',
  'user',
  'plus',
  'gear',
  'sort',
  'calendar',
] as const;

const Kind = z
  .enum(['string', 'sprint'])
  .describe('"string" = custom state sticker, "sprint" = sprint sticker');
type Kind = z.infer<typeof Kind>;

const base = (kind: Kind): string => `/${kind}-stickers`;
const stateName = (kind: Kind): string => (kind === 'string' ? 'string sticker' : 'sprint sticker');

/** Rejects fields that only exist for the other kind (the spec DTOs differ). */
function foreignFields(
  kind: Kind,
  fields: { icon?: unknown; color?: unknown; begin?: unknown; end?: unknown },
): string | undefined {
  const bad =
    kind === 'string'
      ? (['begin', 'end'] as const).filter((k) => fields[k] !== undefined)
      : (['icon', 'color'] as const).filter((k) => fields[k] !== undefined);
  return bad.length ? `${bad.join(', ')} not supported for ${stateName(kind)}s` : undefined;
}

export const registerStickersTools: ToolGroup = (server, deps) => {
  const { client, config } = deps;

  const guard =
    <A>(fn: (args: A, signal: AbortSignal) => Promise<CallToolResult>) =>
    async (args: A, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      // One deadline per tool call, shared by every request it makes (read-modify-write, fetchAll paging).
      const signal = AbortSignal.any([
        extra.signal,
        AbortSignal.timeout(Math.max(60_000, 4 * config.timeoutMs)),
      ]);
      try {
        return await fn(args, signal);
      } catch (e) {
        return toToolError(e, config.apiKey);
      }
    };

  // ---------- Read ----------

  server.registerTool(
    'yougile_list_stickers',
    {
      title: 'List stickers',
      description:
        'List string or sprint stickers with their states (GET /string-stickers or /sprint-stickers). The state ids are what tasks reference in `stickers`.',
      inputSchema: {
        kind: Kind,
        boardId: Id.optional(),
        name: z.string().optional(),
        includeDeleted: IncDel,
        limit: Limit,
        offset: Offset,
      },
      annotations: READ,
    },
    guard(async (a, signal) => {
      const res = await client.request<{
        content?: unknown[];
        paging?: Record<string, number | boolean>;
      }>('GET', base(a.kind), {
        query: stripUndefined({
          boardId: a.boardId,
          name: a.name,
          includeDeleted: a.includeDeleted ? true : undefined,
          limit: a.limit,
          offset: a.offset,
        }),
        signal,
      });
      const items = res.content ?? [];
      return toolResult({ items, paging: pagingOf(res.paging, a.limit, a.offset, items.length) });
    }),
  );

  server.registerTool(
    'yougile_get_sticker',
    {
      title: 'Get sticker',
      description: 'Get one string or sprint sticker with its states.',
      inputSchema: { kind: Kind, id: Id },
      annotations: READ,
    },
    guard(async (a: { kind: Kind; id: string }, signal) =>
      toolResult({
        ...(await client.request<Record<string, unknown>>(
          'GET',
          `${base(a.kind)}/${encodeId(a.id)}`,
          { signal },
        )),
      }),
    ),
  );

  if (!config.allowWrites) return;

  // ---------- Write ----------

  server.registerTool(
    'yougile_create_sticker',
    {
      title: 'Create sticker',
      description:
        'Create a sticker (POST /string-stickers or /sprint-stickers). String stickers accept `icon` and states {name, color}; ' +
        'sprint stickers accept states {name, begin, end} (dates as epoch seconds or ISO-8601). Fields of the other kind are rejected. Returns the new id.',
      inputSchema: {
        kind: Kind,
        name: z.string().min(1),
        icon: z.enum(ICONS).optional().describe('string stickers only'),
        states: z
          .array(
            z.object({
              name: z.string().min(1),
              color: z.string().optional().describe('string stickers only'),
              begin: EpochSeconds.optional().describe('sprint stickers only'),
              end: EpochSeconds.optional().describe('sprint stickers only'),
            }),
          )
          .optional(),
      },
      annotations: CREATE,
    },
    guard(async (a, signal) => {
      const err = foreignFields(a.kind, { icon: a.icon });
      if (err) return localError(err);
      for (const s of a.states ?? []) {
        const e = foreignFields(a.kind, s);
        if (e) return localError(`states: ${e}`);
      }
      const body = stripUndefined({
        name: a.name,
        icon: a.icon,
        states: a.states?.map((s) => stripUndefined(s)),
      });
      return toolResult({
        ...(await client.request<Record<string, unknown>>('POST', base(a.kind), { body, signal })),
      });
    }),
  );

  server.registerTool(
    'yougile_update_sticker',
    {
      title: 'Update sticker',
      description:
        'Rename a sticker or change its icon (icon: string stickers only). At least one field is required.',
      inputSchema: {
        kind: Kind,
        id: Id,
        name: z.string().min(1).optional(),
        icon: z.enum(ICONS).optional(),
      },
      annotations: UPDATE,
    },
    guard(async (a, signal) => {
      const err = foreignFields(a.kind, { icon: a.icon });
      if (err) return localError(err);
      const body = stripUndefined({ name: a.name, icon: a.icon });
      if (Object.keys(body).length === 0) return localError('provide at least one field to update');
      return toolResult({
        ...(await client.request<Record<string, unknown>>(
          'PUT',
          `${base(a.kind)}/${encodeId(a.id)}`,
          { body, signal },
        )),
      });
    }),
  );

  server.registerTool(
    'yougile_create_sticker_state',
    {
      title: 'Create sticker state',
      description:
        'Add a state to a sticker (POST …/{stickerId}/states). color: string stickers only; begin/end (epoch seconds or ISO-8601): sprint stickers only. Returns the new state id.',
      inputSchema: {
        kind: Kind,
        stickerId: Id,
        name: z.string().min(1),
        color: z.string().optional(),
        begin: EpochSeconds.optional(),
        end: EpochSeconds.optional(),
      },
      annotations: CREATE,
    },
    guard(async (a, signal) => {
      const err = foreignFields(a.kind, a);
      if (err) return localError(err);
      const body = stripUndefined({ name: a.name, color: a.color, begin: a.begin, end: a.end });
      return toolResult({
        ...(await client.request<Record<string, unknown>>(
          'POST',
          `${base(a.kind)}/${encodeId(a.stickerId)}/states`,
          {
            body,
            signal,
          },
        )),
      });
    }),
  );

  server.registerTool(
    'yougile_update_sticker_state',
    {
      title: 'Update sticker state',
      description:
        'Change a sticker state (PUT …/{stickerId}/states/{stateId}). color: string stickers only; begin/end: sprint stickers only. At least one field is required.',
      inputSchema: {
        kind: Kind,
        stickerId: Id,
        stateId: Id,
        name: z.string().min(1).optional(),
        color: z.string().optional(),
        begin: EpochSeconds.optional(),
        end: EpochSeconds.optional(),
      },
      annotations: UPDATE,
    },
    guard(async (a, signal) => {
      const err = foreignFields(a.kind, a);
      if (err) return localError(err);
      const body = stripUndefined({ name: a.name, color: a.color, begin: a.begin, end: a.end });
      if (Object.keys(body).length === 0) return localError('provide at least one field to update');
      return toolResult({
        ...(await client.request<Record<string, unknown>>(
          'PUT',
          `${base(a.kind)}/${encodeId(a.stickerId)}/states/${encodeId(a.stateId)}`,
          { body, signal },
        )),
      });
    }),
  );

  if (!config.allowDestructive) return;

  // ---------- Destructive ----------

  server.registerTool(
    'yougile_delete_sticker',
    {
      title: 'Delete sticker (soft)',
      description:
        'Soft-delete a sticker (PUT … with deleted=true). Requires confirm=true. Undo with yougile_restore (kinds string_sticker / sprint_sticker).',
      inputSchema: { kind: Kind, id: Id, confirm: z.literal(true) },
      annotations: REMOVE,
    },
    guard(async (a: { kind: Kind; id: string; confirm: true }, signal) =>
      toolResult({
        ...(await client.request<Record<string, unknown>>(
          'PUT',
          `${base(a.kind)}/${encodeId(a.id)}`,
          {
            body: { deleted: true },
            signal,
          },
        )),
        deleted: true,
      }),
    ),
  );

  server.registerTool(
    'yougile_delete_sticker_state',
    {
      title: 'Delete sticker state (soft)',
      description:
        'Soft-delete one state of a sticker (PUT …/states/{stateId} with deleted=true). Requires confirm=true.',
      inputSchema: { kind: Kind, stickerId: Id, stateId: Id, confirm: z.literal(true) },
      annotations: REMOVE,
    },
    guard(async (a: { kind: Kind; stickerId: string; stateId: string; confirm: true }, signal) =>
      toolResult({
        ...(await client.request<Record<string, unknown>>(
          'PUT',
          `${base(a.kind)}/${encodeId(a.stickerId)}/states/${encodeId(a.stateId)}`,
          { body: { deleted: true }, signal },
        )),
        deleted: true,
      }),
    ),
  );
};
