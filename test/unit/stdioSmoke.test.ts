import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const entry = resolve(import.meta.dirname, '../../src/index.ts');
const tsx = resolve(import.meta.dirname, '../../node_modules/.bin/tsx');
const built = resolve(import.meta.dirname, '../../dist/index.js');

interface Run {
  stdoutLines: string[];
  stderr: string;
  code: number | null;
}

/** Spawns the real server, sends JSON-RPC lines on stdin, then closes stdin. No network: the base URL is never contacted. */
function run(env: Record<string, string>, input: object[], useBuilt: boolean): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const child = useBuilt
      ? spawn(process.execPath, [built], { env: { PATH: process.env.PATH ?? '', ...env } })
      : spawn(tsx, [entry], { env: { PATH: process.env.PATH ?? '', ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      resolveRun({ stdoutLines: out.split('\n').filter(Boolean), stderr: err, code }),
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', () => clearTimeout(timer));
    child.stdin.write(input.map((m) => JSON.stringify(m)).join('\n') + '\n');
    // Give the server time to answer before EOF closes it.
    setTimeout(() => child.stdin.end(), 3000);
  });
}

const handshake = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

describe.each([
  ['source (tsx)', false],
  ['built dist', true],
])('stdio smoke: %s', (_n, useBuilt) => {
  const skip = useBuilt && !existsSync(built);
  it.skipIf(skip)(
    'stdout carries only JSON-RPC and lists tools',
    async () => {
      const r = await run(
        {
          YOUGILE_API_KEY: 'smoke-secret-key',
          YOUGILE_BASE_URL: 'http://127.0.0.1:9',
          YOUGILE_ALLOW_WRITES: 'true',
          YOUGILE_ALLOW_DESTRUCTIVE: 'true',
        },
        handshake,
        useBuilt,
      );
      expect(r.stdoutLines.length).toBeGreaterThanOrEqual(2);
      const msgs = r.stdoutLines.map(
        (l) => JSON.parse(l) as { jsonrpc?: string; id?: number; result?: { tools?: unknown[] } },
      );
      for (const m of msgs) expect(m.jsonrpc).toBe('2.0');
      const list = msgs.find((m) => m.id === 2);
      expect(list?.result?.tools).toHaveLength(66);
      expect(r.stderr).not.toContain('smoke-secret-key');
      expect(r.code).toBe(0);
    },
    30_000,
  );

  it.skipIf(skip)(
    'invalid config exits 2 with one secret-free stderr line and empty stdout',
    async () => {
      const r = await run(
        { YOUGILE_API_KEY: 'smoke-secret-key', YOUGILE_BASE_URL: 'http://evil.example' },
        [],
        useBuilt,
      );
      expect(r.code).toBe(2);
      expect(r.stdoutLines).toEqual([]);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).not.toContain('smoke-secret-key');
    },
    30_000,
  );
});
