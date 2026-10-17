/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles assert on loosely typed request/response bodies */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../src/config.js';
import type { YouGileClient } from '../../src/http/client.js';
import type { ToolGroup } from '../../src/tools/_shared.js';

export interface Call {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: any;
  idempotent?: boolean;
}

/** Scripted stand-in for YouGileClient (the real client is built concurrently): records calls, replies in order. */
export function fakeClient(script: unknown[] = []) {
  const calls: Call[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const paginateCalls: Array<{ path: string; query: Record<string, unknown>; opts: any }> = [];
  let i = 0;
  const client = {
    async request(method: string, path: string, opts: any = {}) {
      calls.push({ method, path, query: opts.query, body: opts.body, idempotent: opts.idempotent });
      signals.push(opts.signal);
      const next = script[i++];
      if (next instanceof Error) throw next;
      return next ?? { id: 'x' };
    },
    async paginate(path: string, query: Record<string, unknown>, opts: any) {
      paginateCalls.push({ path, query, opts });
      const next = script[i++];
      return next ?? { items: [], nextOffset: null, truncated: false };
    },
  } as unknown as YouGileClient;
  return { client, calls, paginateCalls, signals };
}

export const baseConfig: Config = {
  apiKey: 'secret-key-123',
  baseUrl: 'https://yougile.com',
  allowWrites: false,
  allowDestructive: false,
  rateLimitPerMin: 40,
  timeoutMs: 15000,
  maxItems: 500,
  logLevel: 'error',
};

export async function connect(group: ToolGroup, config: Partial<Config>, script: unknown[] = []) {
  const fake = fakeClient(script);
  const server = new McpServer({ name: 't', version: '0' });
  group(server, { client: fake.client, config: { ...baseConfig, ...config } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const toolNames = async () => (await mcp.listTools()).tools.map((t) => t.name).sort();
  const call = (name: string, args: Record<string, unknown>) =>
    mcp.callTool({ name, arguments: args }) as Promise<{
      isError?: boolean;
      structuredContent?: any;
      content: Array<{ type: string; text: string }>;
    }>;
  return { ...fake, mcp, toolNames, call };
}
