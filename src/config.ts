import { z } from 'zod';

export interface Config {
  apiKey: string;
  baseUrl: string;
  allowWrites: boolean;
  allowDestructive: boolean;
  rateLimitPerMin: number;
  timeoutMs: number;
  maxItems: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

/** Thrown for invalid environment. The message never contains secrets. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const intRange = (min: number, max: number, def: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const EnvSchema = z.object({
  YOUGILE_API_KEY: z.string().min(1),
  YOUGILE_BASE_URL: z.string().url().default('https://yougile.com'),
  YOUGILE_ALLOW_WRITES: bool,
  YOUGILE_ALLOW_DESTRUCTIVE: bool,
  YOUGILE_RATE_LIMIT_PER_MIN: intRange(1, 50, 40),
  YOUGILE_TIMEOUT_MS: intRange(1000, 60000, 15000),
  YOUGILE_MAX_ITEMS: intRange(1, 5000, 500),
  YOUGILE_LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only variable names and zod messages — never values.
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'env'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  if (e.YOUGILE_ALLOW_DESTRUCTIVE && !e.YOUGILE_ALLOW_WRITES) {
    throw new ConfigError('YOUGILE_ALLOW_DESTRUCTIVE requires YOUGILE_ALLOW_WRITES=true');
  }
  const url = new URL(e.YOUGILE_BASE_URL);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new ConfigError('YOUGILE_BASE_URL must use https (http only for localhost/127.0.0.1)');
  }
  return Object.freeze({
    apiKey: e.YOUGILE_API_KEY,
    baseUrl: url.origin,
    allowWrites: e.YOUGILE_ALLOW_WRITES,
    allowDestructive: e.YOUGILE_ALLOW_DESTRUCTIVE,
    rateLimitPerMin: e.YOUGILE_RATE_LIMIT_PER_MIN,
    timeoutMs: e.YOUGILE_TIMEOUT_MS,
    maxItems: e.YOUGILE_MAX_ITEMS,
    logLevel: e.YOUGILE_LOG_LEVEL,
  });
}
