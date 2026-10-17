import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { errorFromStatus, YouGileError } from './errors.js';
import type { RateLimiter } from './rateLimiter.js';
import { backoffMs, isRetryable, parseRetryAfter } from './retry.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotent?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Internal shared deadline for multi-page reads. */
  deadline?: number;
}
export interface Page<T> {
  items: T[];
  count?: number;
  nextOffset: number | null;
  truncated: boolean;
}

export class YouGileClient {
  constructor(
    protected readonly cfg: Pick<Config, 'apiKey' | 'baseUrl' | 'timeoutMs'>,
    protected readonly limiter: RateLimiter,
    protected readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    const deadline = opts.deadline ?? Date.now() + Math.max(60_000, 4 * this.cfg.timeoutMs);
    const idempotent = opts.idempotent ?? method === 'GET';
    const existingKey =
      typeof opts.body === 'object' && opts.body !== null && 'idempotencyKey' in opts.body
        ? (opts.body as { idempotencyKey?: unknown }).idempotencyKey
        : undefined;
    const key =
      opts.idempotencyKey ??
      (typeof existingKey === 'string' ? existingKey : undefined) ??
      (method === 'POST' && idempotent ? randomUUID() : undefined);
    const requestBody =
      method === 'POST' &&
      key &&
      typeof opts.body === 'object' &&
      opts.body !== null &&
      !Array.isArray(opts.body)
        ? { ...(opts.body as Record<string, unknown>), idempotencyKey: key }
        : opts.body;
    let attempt = 0;
    let last: YouGileError | undefined;
    while (attempt < 3) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new YouGileError('Request timed out', 'timeout');
      const overall = AbortSignal.timeout(remaining);
      const signal = opts.signal ? AbortSignal.any([opts.signal, overall]) : overall;
      let requestSignal: AbortSignal | undefined;
      try {
        await this.limiter.acquire(signal);
        const url = new URL(
          `${this.cfg.baseUrl.replace(/\/$/, '')}/api-v2${path.startsWith('/') ? path : `/${path}`}`,
        );
        for (const [k, v] of Object.entries(opts.query ?? {}))
          if (v !== undefined) url.searchParams.set(k, String(v));
        const timeout = AbortSignal.timeout(Math.min(this.cfg.timeoutMs, remaining));
        requestSignal = AbortSignal.any([signal, timeout]);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          Accept: 'application/json',
        };
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
          signal: requestSignal,
        });
        if (response.ok) {
          if (response.status === 204) return undefined as T;
          const rawSuccess = await response.text();
          if (!rawSuccess.trim()) return undefined as T;
          try {
            return JSON.parse(rawSuccess) as T;
          } catch {
            throw new YouGileError('Invalid JSON response', 'unknown', response.status);
          }
        }
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
        if (response.status === 429)
          this.limiter.penalize(
            Math.min(retryAfter ?? (60_000 / this.limiter.perMinute) * 4, 60_000),
          );
        const raw = await response.text();
        let message = response.statusText || 'Request failed';
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null) {
            const obj = parsed as Record<string, unknown>;
            const value = obj.error ?? obj.message;
            if (typeof value === 'string') message = value;
            else if (Array.isArray(value) && value.every((x) => typeof x === 'string'))
              message = value.join(', ');
          }
        } catch {
          /* retain status text */
        }
        message = message
          .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
          .replace(/<[^>]*>/g, '[HTML]')
          .replace(/[\r\n\t]+/g, ' ')
          .slice(0, 300);
        const statusRetryable = isRetryable(method, idempotent, { status: response.status });
        if (
          !statusRetryable &&
          method !== 'GET' &&
          response.status >= 500 &&
          (method !== 'POST' || !idempotent)
        ) {
          throw new YouGileError(message, 'unknown_outcome', response.status);
        }
        last = errorFromStatus(response.status, message, statusRetryable);
        if (
          response.status === 429 &&
          retryAfter !== undefined &&
          retryAfter >= deadline - Date.now()
        )
          throw last;
        if (
          !statusRetryable ||
          attempt >= (method === 'GET' || (method === 'POST' && idempotent) ? 2 : 1)
        )
          throw last;
        try {
          await this.wait(backoffMs(attempt++, retryAfter), signal);
        } catch {
          // The HTTP rejection is known even when its retry delay outlasts the call.
          throw last;
        }
      } catch (e) {
        if (e === last) throw last;
        if (e instanceof YouGileError) throw e;
        const timedOut =
          signal.aborted ||
          (e instanceof Error && e.name === 'TimeoutError') ||
          Boolean(requestSignal?.aborted);
        const network = !timedOut;
        const retryable = isRetryable(method, idempotent, {
          status: null,
          network,
          timeout: timedOut,
        });
        if (!retryable) {
          if (method !== 'GET' && !idempotent && (timedOut || network))
            throw new YouGileError(
              'Write outcome is unknown; re-read before retrying',
              'unknown_outcome',
            );
          throw timedOut
            ? new YouGileError('Request timed out', 'timeout')
            : new YouGileError('Network request failed', 'network');
        }
        if (attempt >= 2)
          throw timedOut
            ? new YouGileError('Request timed out', 'timeout')
            : new YouGileError('Network request failed', 'network');
        await this.wait(backoffMs(attempt++), signal);
      }
    }
    throw last ?? new YouGileError('Request failed', 'unknown');
  }

  async paginate<T>(
    path: string,
    query: Record<string, unknown>,
    opts: { offset: number; maxItems: number; signal?: AbortSignal },
  ): Promise<Page<T>> {
    const deadline = Date.now() + Math.max(60_000, 4 * this.cfg.timeoutMs);
    const items: T[] = [];
    let offset = opts.offset;
    let count: number | undefined;
    let hasNext = false;
    while (items.length < opts.maxItems) {
      if (Date.now() >= deadline || opts.signal?.aborted)
        return {
          items,
          ...(count === undefined ? {} : { count }),
          nextOffset: offset,
          truncated: true,
        };
      const limit = Math.min(1000, opts.maxItems - items.length);
      let response: {
        content?: T[];
        data?: T[];
        items?: T[];
        paging?: { count?: number; next?: boolean; offset?: number };
      };
      try {
        response = await this.request<{
          content?: T[];
          data?: T[];
          items?: T[];
          paging?: { count?: number; next?: boolean; offset?: number };
        }>('GET', path, {
          query: { ...query, limit, offset },
          ...(opts.signal ? { signal: opts.signal } : {}),
          deadline,
        });
      } catch (error) {
        if (opts.signal?.aborted && opts.signal.reason?.name !== 'TimeoutError') throw error;
        if (
          items.length > 0 &&
          error instanceof YouGileError &&
          (error.code === 'timeout' || error.code === 'network')
        )
          return {
            items,
            ...(count === undefined ? {} : { count }),
            nextOffset: offset,
            truncated: true,
          };
        throw error;
      }
      const pageItems = response.content ?? response.data ?? response.items ?? [];
      items.push(...pageItems.slice(0, limit));
      count = response.paging?.count ?? count;
      hasNext = Boolean(response.paging?.next);
      if (!hasNext || pageItems.length === 0) break;
      offset = offset + pageItems.length;
    }
    const truncated = hasNext && items.length >= opts.maxItems;
    return {
      items,
      ...(count === undefined ? {} : { count }),
      nextOffset: hasNext ? offset : null,
      truncated,
    };
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    if (signal.aborted) throw new YouGileError('Request timed out', 'timeout');
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        cleanup();
        reject(new YouGileError('Request timed out', 'timeout'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
