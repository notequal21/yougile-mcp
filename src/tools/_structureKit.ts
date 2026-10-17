import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape, z } from 'zod';
import { toToolError } from '../http/errors.js';
import type { ToolDeps } from './_shared.js';

// Local helpers for the structure tool groups (users, company, projects, roles, departments, boards, columns).
// TODO(coordinator): fold into _shared.ts once the shared helpers land.

export type Tier = 'read' | 'write' | 'destructive';

export const ANNOTATIONS = {
  read: { readOnlyHint: true, openWorldHint: true },
  create: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  update: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  destructive: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
} as const;

export interface ToolResult {
  [key: string]: unknown;
  content: [{ type: 'text'; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function ok(result: unknown): ToolResult {
  const structured =
    typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { result };
  return {
    content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }],
    structuredContent: structured,
  };
}

export function localError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: `YouGile validation: ${message}` }] };
}

/** Drop `undefined` values so partial updates only send provided keys (ARCHITECTURE §7.3). */
export function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const newIdempotencyKey = (): string => randomUUID();
export const seg = (id: string): string => encodeURIComponent(id);

interface ListEnvelope {
  content?: unknown[];
  paging?: { count?: number; limit?: number; offset?: number; next?: boolean };
}

/** Single-request list result: `{ items, paging }` (ARCHITECTURE §5.5). */
export function listResult(
  raw: ListEnvelope,
  limit: number,
  offset: number,
): Record<string, unknown> {
  const items = Array.isArray(raw.content) ? raw.content : [];
  const next = raw.paging?.next === true;
  return {
    items,
    paging: {
      count: raw.paging?.count,
      limit,
      offset,
      next,
      nextOffset: next ? offset + items.length : null,
    },
  };
}

/** Registers a tool if its gate is open; a disabled tool is not registered at all. */
export function defineGated<Shape extends ZodRawShape>(
  server: McpServer,
  deps: ToolDeps,
  tier: Tier,
  name: string,
  spec: {
    title: string;
    description: string;
    inputSchema: Shape;
    annotations: (typeof ANNOTATIONS)[keyof typeof ANNOTATIONS];
  },
  handler: (
    args: z.objectOutputType<Shape, z.ZodTypeAny>,
    extra: { signal?: AbortSignal },
  ) => Promise<ToolResult>,
): void {
  if (tier === 'write' && !deps.config.allowWrites) return;
  if (tier === 'destructive' && !(deps.config.allowWrites && deps.config.allowDestructive)) return;
  server.registerTool(name, spec, (async (
    args: z.objectOutputType<Shape, z.ZodTypeAny>,
    extra: { signal?: AbortSignal },
  ) => {
    try {
      return await handler(args, extra);
    } catch (e) {
      return toToolError(e, deps.config.apiKey);
    }
  }) as never);
}
