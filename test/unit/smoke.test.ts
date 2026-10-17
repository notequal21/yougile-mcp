import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { YouGileClient } from '../../src/http/client.js';
import { RateLimiter } from '../../src/http/rateLimiter.js';
import { createServer } from '../../src/server.js';
import { createFakeFetch } from '../helpers/fakeFetch.js';

describe('scaffold smoke', () => {
  it('loadConfig applies defaults', () => {
    const cfg = loadConfig({ YOUGILE_API_KEY: 'k' });
    expect(cfg.baseUrl).toBe('https://yougile.com');
    expect(cfg.allowWrites).toBe(false);
    expect(cfg.rateLimitPerMin).toBe(40);
  });

  it('loadConfig error does not leak the key', () => {
    expect(() =>
      loadConfig({ YOUGILE_API_KEY: 'secret-key', YOUGILE_BASE_URL: 'http://evil.example' }),
    ).toThrow(/https/);
    try {
      loadConfig({ YOUGILE_API_KEY: 'secret-key', YOUGILE_TIMEOUT_MS: '1' });
    } catch (e) {
      expect(String(e)).not.toContain('secret-key');
    }
  });

  it('server starts and connects over an in-memory transport', async () => {
    const config = loadConfig({ YOUGILE_API_KEY: 'k' });
    const { fetch: fakeFetch } = createFakeFetch([]);
    const client = new YouGileClient(config, new RateLimiter(config.rateLimitPerMin), fakeFetch);
    const server = createServer(config, { client });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    expect(mcp.getServerVersion()?.name).toBe('yougile-mcp');
    await mcp.close();
  });
});
