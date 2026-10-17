import { describe, expect, it } from 'vitest';
import { YouGileClient } from '../../../src/http/client.js';
import { RateLimiter } from '../../../src/http/rateLimiter.js';
import { createFakeFetch } from '../../helpers/fakeFetch.js';

describe('QA: rejected write with a long Retry-After', () => {
  it('records the current outcome after the deadline interrupts the 429 wait', async () => {
    const fake = createFakeFetch([
      { status: 429, headers: { 'Retry-After': '3600' }, body: { message: 'rate limited' } },
    ]);
    const client = new YouGileClient(
      { apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1', timeoutMs: 1000 },
      new RateLimiter(50),
      fake.fetch,
    );
    await expect(
      client.request('POST', '/chats/id/messages', {
        body: { text: 'hello' },
        deadline: Date.now() + 30,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect(fake.calls).toHaveLength(1);
  });
});
