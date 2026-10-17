import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { YouGileClient } from '../http/client.js';

export interface ToolDeps {
  client: YouGileClient;
  config: Config;
}
export type ToolGroup = (server: McpServer, deps: ToolDeps) => void;
export const Id = z.string().min(1).max(100);
export const Limit = z.number().int().min(1).max(1000).default(50);
export const Offset = z.number().int().min(0).default(0);
export const IncDel = z.boolean().default(false);
const ISO_HINT = 'epoch milliseconds (number) or an ISO-8601 string such as "2026-10-20T12:00:00Z"';

/** Validate the input's local calendar date before converting an offset datetime to UTC. */
export const EpochMs = z
  .union([z.number().int().min(0), z.string().min(1)])
  .transform((value, ctx) => {
    if (typeof value === 'number') return value;
    const match =
      /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2})))?$/.exec(
        value,
      );
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const calendar = new Date(0);
      calendar.setUTCFullYear(year, month - 1, day);
      if (
        calendar.getUTCFullYear() === year &&
        calendar.getUTCMonth() === month - 1 &&
        calendar.getUTCDate() === day &&
        (match[4] === undefined ||
          (Number(match[4]) <= 23 &&
            Number(match[5]) <= 59 &&
            Number(match[6]) <= 59 &&
            (match[8] === 'Z' || (Number(match[9]) <= 23 && Number(match[10]) <= 59))))
      ) {
        const ms = Date.parse(value);
        if (Number.isFinite(ms)) return ms;
      }
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid date, use ${ISO_HINT}` });
    return z.NEVER;
  })
  .describe(ISO_HINT);

export const readAnnotations = { readOnlyHint: true, openWorldHint: true } as const;
export const createAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;
export const updateAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;
export const replaceAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
} as const;
export const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
} as const;

export function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}
export function listResult<T>(
  items: T[],
  count: number | undefined,
  limit: number,
  offset: number,
  next: boolean,
) {
  const nextOffset = next ? offset + items.length : null;
  return {
    items,
    paging: { ...(count === undefined ? {} : { count }), limit, offset, next, nextOffset },
  };
}
export function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
export function requireOneField(value: Record<string, unknown>, fields: string[]): void {
  if (!fields.some((field) => value[field] !== undefined))
    throw new Error('At least one update field is required');
}
export function defineTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Record<string, z.ZodTypeAny>,
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>,
  annotations: Record<string, boolean> = readAnnotations,
): void {
  server.registerTool(name, { description, inputSchema, annotations }, async (args, extra) =>
    handler(args as Record<string, unknown>, extra),
  );
}
