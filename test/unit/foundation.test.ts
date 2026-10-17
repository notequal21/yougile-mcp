import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { taskDetail, taskSummary } from '../../src/format/project.js';
import { YouGileClient } from '../../src/http/client.js';
import { YouGileError, toToolError } from '../../src/http/errors.js';
import { RateLimiter } from '../../src/http/rateLimiter.js';
import { backoffMs, isRetryable, parseRetryAfter } from '../../src/http/retry.js';

describe('configuration', () => {
  it('freezes defaults and strips base path/query to origin', () => {
    const config = loadConfig({
      YOUGILE_API_KEY: 'secret',
      YOUGILE_BASE_URL: 'https://example.com/a?b=c',
    });
    expect(config.baseUrl).toBe('https://example.com');
    expect(config).toMatchObject({
      rateLimitPerMin: 40,
      timeoutMs: 15000,
      maxItems: 500,
      allowWrites: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });
  it('rejects unsafe origins, bounds, destructive without writes, without leaking key', () => {
    for (const env of [
      { YOUGILE_API_KEY: 'secret-key', YOUGILE_BASE_URL: 'http://example.com' },
      { YOUGILE_API_KEY: 'secret-key', YOUGILE_RATE_LIMIT_PER_MIN: '51' },
      { YOUGILE_API_KEY: 'secret-key', YOUGILE_ALLOW_DESTRUCTIVE: 'true' },
    ])
      expect(() => loadConfig(env)).toThrow(/https|Invalid|requires/);
    try {
      loadConfig({ YOUGILE_API_KEY: 'secret-key', YOUGILE_TIMEOUT_MS: '0' });
    } catch (e) {
      expect(String(e)).not.toContain('secret-key');
    }
    expect(
      loadConfig({ YOUGILE_API_KEY: 'x', YOUGILE_BASE_URL: 'http://localhost:3000/path' }).baseUrl,
    ).toBe('http://localhost:3000');
  });
});

describe('errors and retry policy', () => {
  it('sanitizes key, URLs, HTML, line breaks and caps message', () => {
    const result = toToolError(
      new YouGileError(
        `bad secret https://host/path?q=1 <b>x</b>\n${'x'.repeat(400)}`,
        'auth',
        401,
      ),
      'secret',
    );
    const text = result.content[0].text;
    expect(text).toContain('YouGile auth (HTTP 401)');
    expect(text).toContain('check YOUGILE_API_KEY');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('<b>');
    expect(text.length).toBeLessThan(400);
  });
  it('follows method retry matrix and parses retry-after', () => {
    expect(isRetryable('GET', true, { status: 503 })).toBe(true);
    expect(isRetryable('POST', true, { status: null, network: true })).toBe(true);
    expect(isRetryable('POST', false, { status: null, network: true })).toBe(false);
    expect(isRetryable('POST', false, { status: 429 })).toBe(true);
    expect(isRetryable('PUT', true, { status: 503 })).toBe(false);
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1000)).toBe(2000);
    expect(backoffMs(2, undefined, () => 0.5)).toBe(1000);
  });
});

describe('limiter/client/projections', () => {
  it('does not refill during a penalty pause', async () => {
    vi.useFakeTimers();
    let now = 0;
    const limiter = new RateLimiter(60, () => now);
    await limiter.acquire();
    limiter.penalize(10_000);
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    now = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'timeout' });
    vi.useRealTimers();
  });
  it('grants initial burst and queues later acquisitions FIFO', async () => {
    const limiter = new RateLimiter(120);
    for (let i = 0; i < 5; i++) await limiter.acquire();
    const order: number[] = [];
    const p1 = limiter.acquire().then(() => {
      order.push(1);
    });
    const p2 = limiter.acquire().then(() => {
      order.push(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(order).toEqual([1, 2]);
    await Promise.all([p1, p2]);
  });
  it('reuses idempotency key and bounds page sizes while paginating', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const offset = new URL(String(input)).searchParams.get('offset');
      return new Response(
        JSON.stringify({
          content: offset === '0' ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
          paging: { count: 3, next: offset === '0' },
        }),
        { status: 200 },
      );
    });
    const cfg = loadConfig({ YOUGILE_API_KEY: 'k' });
    const client = new YouGileClient(cfg, new RateLimiter(50), fetcher);
    const page = await client.paginate<{ id: number }>('/tasks', {}, { offset: 0, maxItems: 3 });
    expect(page.items).toHaveLength(3);
    expect(page.truncated).toBe(false);
    const failedFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection'))
      .mockResolvedValueOnce(new Response('{"id":"ok"}', { status: 200 }));
    const retryClient = new YouGileClient(cfg, new RateLimiter(50), failedFetch);
    await retryClient.request('POST', '/projects', {
      body: { title: 'x' },
      idempotent: true,
      idempotencyKey: 'same',
    });
    expect(JSON.parse(String(failedFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      title: 'x',
      idempotencyKey: 'same',
    });
    expect(JSON.parse(String(failedFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      title: 'x',
      idempotencyKey: 'same',
    });
    expect(failedFetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Idempotency-Key');
  });
  it('does not retry a timed out write and acquires limiter on every retry', async () => {
    const cfg = loadConfig({ YOUGILE_API_KEY: 'k', YOUGILE_TIMEOUT_MS: '1000' });
    const acquire = vi.fn(async () => {});
    const limiter = { acquire, penalize: vi.fn(), perMinute: 40 } as unknown as RateLimiter;
    const timeoutFetch = vi.fn(
      (_input: Request | URL | string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Timed out', 'TimeoutError')),
            { once: true },
          );
        }),
    );
    const client = new YouGileClient(cfg, limiter, timeoutFetch);
    await expect(
      client.request('POST', '/users', { body: { email: 'a@b.c' } }),
    ).rejects.toMatchObject({ code: 'unknown_outcome' });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const retryFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await new YouGileClient(cfg, limiter, retryFetch).request('GET', '/users');
    expect(retryFetch).toHaveBeenCalledTimes(3);
    expect(acquire).toHaveBeenCalledTimes(4);
  });

  it('reports unknown outcome for non-idempotent write 5xx responses', async () => {
    const cfg = loadConfig({ YOUGILE_API_KEY: 'k' });
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const fetcher = vi.fn(
        async () =>
          new Response('{"message":"temporary failure"}', {
            status: 503,
            statusText: 'Service Unavailable',
          }),
      );
      const client = new YouGileClient(cfg, new RateLimiter(50), fetcher);
      await expect(
        client.request(method, '/resource', {
          body: method === 'DELETE' ? undefined : { title: 'x' },
          idempotent: false,
        }),
      ).rejects.toMatchObject({ code: 'unknown_outcome', status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('returns partial pages on timeout and removes aborted limiter waiters', async () => {
    const cfg = loadConfig({ YOUGILE_API_KEY: 'k' });
    let n = 0;
    const fetcher = vi.fn(async () => {
      n++;
      if (n === 1)
        return new Response(
          JSON.stringify({ items: [{ id: 1 }], paging: { count: 2, next: true } }),
          { status: 200 },
        );
      throw new DOMException('cancelled', 'AbortError');
    });
    const client = new YouGileClient(cfg, new RateLimiter(50), fetcher);
    const page = await client.paginate<{ id: number }>('/users', {}, { offset: 0, maxItems: 5 });
    expect(page).toMatchObject({ items: [{ id: 1 }], nextOffset: 1, truncated: true });

    const limiter = new RateLimiter(1);
    await limiter.acquire();
    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('caps every page request at the shared pagination deadline', async () => {
    const cfg = loadConfig({ YOUGILE_API_KEY: 'k' });
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ content: [{ id: 1 }], paging: { next: true } }), {
          status: 200,
        }),
    );
    const client = new YouGileClient(cfg, new RateLimiter(50), fetcher);
    const now = vi.spyOn(Date, 'now');
    const start = 100_000;
    now.mockReturnValueOnce(start).mockReturnValueOnce(start).mockReturnValueOnce(start);
    const page = await client.paginate<{ id: number }>(
      '/task-list',
      {},
      { offset: 0, maxItems: 1 },
    );
    expect(page).toMatchObject({ items: [{ id: 1 }], truncated: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('adds compact task timestamps', () => {
    const summary = taskSummary({
      id: 'a',
      title: 'x',
      timestamp: 0,
      deadline: { deadline: 1000 },
      ignored: true,
    });
    expect(summary).toMatchObject({
      timestampIso: '1970-01-01T00:00:00.000Z',
      deadlineIso: '1970-01-01T00:00:01.000Z',
    });
    expect(summary).not.toHaveProperty('ignored');
    expect(taskDetail({ timestamp: 0 })).toHaveProperty('timestampIso');
  });
});
