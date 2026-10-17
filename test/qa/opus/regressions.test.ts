// Regression tests for independently reported QA findings.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import { YouGileClient } from '../../../src/http/client.js';
import { YouGileError } from '../../../src/http/errors.js';
import { RateLimiter } from '../../../src/http/rateLimiter.js';
import { createServer } from '../../../src/server.js';
import { createFakeFetch } from '../../helpers/fakeFetch.js';

const cfg = { apiKey: 'k', baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 };

afterEach(() => vi.restoreAllMocks());

describe('QA-1: fetchAll drops partial results when the per-call deadline fires', () => {
  // ARCHITECTURE §5.2: a paginated read that hits the deadline returns partial items, truncated: true.
  it('yougile_list_tasks fetchAll returns page 1 with truncated=true', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const deadline = new AbortController();
    let hooked = false;
    // The task guard creates the 60 s per-call deadline first; make it controllable.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      if (!hooked && ms === 60_000) {
        hooked = true;
        return deadline.signal;
      }
      return real(ms);
    });
    let n = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      n++;
      if (n === 1)
        return new Response(
          JSON.stringify({ content: [{ id: 't1', title: 'a' }], paging: { count: 3, next: true } }),
          { status: 200 },
        );
      setTimeout(() => deadline.abort(new DOMException('deadline', 'TimeoutError')), 20);
      return new Promise((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
      );
    }) as typeof fetch;
    const config = loadConfig({ YOUGILE_API_KEY: 'k', YOUGILE_BASE_URL: 'http://127.0.0.1:1' });
    const server = createServer(config, {
      client: new YouGileClient(config, new RateLimiter(50), fetchImpl),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'qa', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    const res = await client.callTool({
      name: 'yougile_list_tasks',
      arguments: { fetchAll: true },
    });
    expect(n).toBe(2);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ items: [{ id: 't1' }], truncated: true });
  });
});

describe('QA-2: Retry-After pauses the shared company limiter with a 60-second cap', () => {
  it.each([
    ['10', 10_000],
    ['86400', 60_000],
  ])('honors Retry-After %s for %i ms across calls', async (header, penalty) => {
    vi.useFakeTimers();
    try {
      const f = createFakeFetch([{ status: 429, headers: { 'Retry-After': header } }]);
      const limiter = new RateLimiter(50);
      const client = new YouGileClient(cfg, limiter, f.fetch);
      // A non-retryable HTTP method would still retry 429, but the header exceeds this call's deadline.
      const err = await client
        .request('GET', '/a', { deadline: Date.now() + 1_000 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(YouGileError);
      expect((err as YouGileError).code).toBe('rate_limited');
      expect(f.calls).toHaveLength(1);
      let acquired = false;
      const unrelated = limiter.acquire().then(() => {
        acquired = true;
      });
      await vi.advanceTimersByTimeAsync(penalty - 1);
      expect(acquired).toBe(false);
      await vi.advanceTimersByTimeAsync(1 + 1_200); // one refill token at 50/min
      await unrelated;
      expect(acquired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QA-3: a 2xx response with a non-JSON body', () => {
  it('GET is not retried as a network error', async () => {
    const f = createFakeFetch([
      { status: 200, body: '<html>proxy page</html>' },
      { status: 200, body: '<html>proxy page</html>' },
      { status: 200, body: '<html>proxy page</html>' },
    ]);
    const client = new YouGileClient(cfg, new RateLimiter(50), f.fetch);
    const err = await client.request('GET', '/users/me').catch((e: unknown) => e);
    expect(f.calls).toHaveLength(1);
    expect((err as YouGileError).code).not.toBe('network');
  });

  it('a PUT that got 200 with an empty body is not reported as unknown_outcome', async () => {
    const f = createFakeFetch([{ status: 200, body: '' }]);
    const client = new YouGileClient(cfg, new RateLimiter(50), f.fetch);
    await expect(
      client.request('PUT', '/tasks/t1', { body: { title: 'x' } }),
    ).resolves.not.toThrow();
  });
});
