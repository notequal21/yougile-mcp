import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const built = resolve(import.meta.dirname, '../../../dist/index.js');

describe('QA: built stdio server with a loopback YouGile fixture', () => {
  it('serves a read tool, gates registration, keeps stdout JSON-RPC, and shuts down', async () => {
    const fixture = createServer((request, response) => {
      expect(request.url).toBe('/api-v2/users/me');
      expect(request.headers.authorization).toBe('Bearer local-fixture-key');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'fixture-user' }));
    });
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('No loopback port');
    try {
      for (const [writes, destructive, expected] of [
        ['false', 'false', 25],
        ['true', 'false', 54],
        ['true', 'true', 66],
      ] as const) {
        const child = spawn(process.execPath, [built], {
          env: {
            PATH: process.env.PATH ?? '',
            YOUGILE_API_KEY: 'local-fixture-key',
            YOUGILE_BASE_URL: `http://127.0.0.1:${address.port}`,
            YOUGILE_ALLOW_WRITES: writes,
            YOUGILE_ALLOW_DESTRUCTIVE: destructive,
          },
        });
        let output = '';
        let stderr = '';
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        const messages: Array<Record<string, unknown>> = [];
        let pending = '';
        const received = new Promise<void>((done, reject) => {
          const timer = setTimeout(() => reject(new Error('stdio response timeout')), 5000);
          child.stdout.on('data', (data: Buffer) => {
            pending += data.toString();
            while (pending.includes('\n')) {
              const index = pending.indexOf('\n');
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
            }
            if (messages.some((message) => message.id === 3)) {
              clearTimeout(timer);
              done();
            }
          });
        });
        for (const message of [
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'qa', version: '1' },
            },
          },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'yougile_whoami', arguments: {} },
          },
        ])
          child.stdin.write(`${JSON.stringify(message)}\n`);
        await received;
        const list = messages.find((message) => message.id === 2)?.result as { tools: unknown[] };
        expect(list.tools).toHaveLength(expected);
        expect(JSON.stringify(messages.find((message) => message.id === 3))).toContain(
          'fixture-user',
        );
        expect(messages.every((message) => message.jsonrpc === '2.0')).toBe(true);
        expect(output.trim().split('\n')).toHaveLength(messages.length);
        expect(stderr).not.toContain('local-fixture-key');
        const exit = new Promise<number | null>((done) => child.on('close', done));
        child.kill('SIGTERM');
        expect(await exit).toBe(0);
      }
    } finally {
      fixture.close();
    }
  }, 20_000);
});
