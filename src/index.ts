#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { YouGileClient } from './http/client.js';
import { RateLimiter } from './http/rateLimiter.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const limiter = new RateLimiter(config.rateLimitPerMin);
  const client = new YouGileClient(config, limiter);
  const server = createServer(config, { client });

  const shutdown = (): void => {
    server
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // stdout carries only JSON-RPC; diagnostics go to stderr.
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  if (e instanceof ConfigError) {
    console.error(`yougile-mcp: ${e.message}`);
    process.exit(2);
  }
  console.error('yougile-mcp: fatal error');
  process.exit(1);
});
