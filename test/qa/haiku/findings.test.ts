// Regression tests for spec and webhook findings.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { YouGileClient } from '../../../src/http/client.js';
import type { RateLimiter } from '../../../src/http/rateLimiter.js';
import { createServer } from '../../../src/server.js';

type Json = Record<string, unknown>;

async function harness() {
  const config = loadConfig({
    YOUGILE_API_KEY: 'qa-haiku-key',
    YOUGILE_ALLOW_WRITES: 'true',
    YOUGILE_ALLOW_DESTRUCTIVE: 'true',
  });
  const bodies: Json[] = [];
  const fetchStub = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Json);
    return new Response(JSON.stringify({ id: 'resp-id' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const limiter = { acquire: async () => undefined, penalize: () => undefined, perMinute: 50 };
  const client = new YouGileClient(config, limiter as unknown as RateLimiter, fetchStub);
  const server = createServer(config, { client });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'haiku-qa-findings', version: '0.0.0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, bodies };
}

const SEC_2026_01_01 = 1767225600; // 2026-01-01T00:00:00Z in seconds

describe('F1 (P1) sprint sticker dates: spec says seconds, tools send milliseconds', () => {
  it('spec: SprintStickerStateDto.begin is "в секундах от 01.01.1970" (seconds)', async () => {
    const { mcp, bodies } = await harness();
    await mcp.callTool({
      name: 'yougile_create_sticker',
      arguments: {
        kind: 'sprint',
        name: 'Sprints',
        states: [{ name: 'S1', begin: '2026-01-01T00:00:00Z' }],
      },
    });
    const states = bodies[0]?.['states'] as Json[];
    expect(states[0]?.['begin']).toBe(SEC_2026_01_01);
  });

  it('spec: sprint state begin/end from ISO input must be seconds on update too', async () => {
    const { mcp, bodies } = await harness();
    await mcp.callTool({
      name: 'yougile_update_sticker_state',
      arguments: { kind: 'sprint', stickerId: 's2', stateId: 'st2', end: '2026-01-01T00:00:00Z' },
    });
    expect(bodies[0]?.['end']).toBe(SEC_2026_01_01);
  });
});

describe('F2 (P2) webhook event: spec allows a JavaScript regexp, the tool rejects regexp alternation', () => {
  it('accepts the documented forms task-* and .*', async () => {
    const { mcp } = await harness();
    for (const event of ['task-*', '.*', 'task-created']) {
      const res = await mcp.callTool({
        name: 'yougile_create_webhook',
        arguments: { url: 'https://example.com/hook', event },
      });
      expect(res.isError, event).toBeFalsy();
    }
  });

  it('spec: "Может использоваться javascript regexp как значение" → task-(created|deleted) is valid', async () => {
    const { mcp } = await harness();
    const res = await mcp.callTool({
      name: 'yougile_create_webhook',
      arguments: { url: 'https://example.com/hook', event: 'task-(created|deleted)' },
    });
    expect(res.isError).toBeFalsy();
  });
});

describe('date input units and ISO validation', () => {
  it('preserves numeric sprint seconds on state creation', async () => {
    const { mcp, bodies } = await harness();
    const res = await mcp.callTool({
      name: 'yougile_create_sticker_state',
      arguments: { kind: 'sprint', stickerId: 's2', name: 'Sprint', begin: SEC_2026_01_01 },
    });
    expect(res.isError).toBeFalsy();
    expect(bodies[0]?.['begin']).toBe(SEC_2026_01_01);
  });

  it.each(['1', '2026', '2026-10-20T10:00'])('rejects ambiguous date %s', async (date) => {
    const { mcp, bodies } = await harness();
    const res = await mcp.callTool({
      name: 'yougile_create_task',
      arguments: { title: 't', deadline: { deadline: date } },
    });
    expect(res.isError).toBe(true);
    expect(bodies).toHaveLength(0);
  });
});
