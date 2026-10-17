import type { Method } from './client.js';

export function isRetryable(
  method: Method,
  idempotent: boolean,
  failure: { status: number | null; network?: boolean; timeout?: boolean },
): boolean {
  const status = failure.status;
  if (method === 'GET' || (method === 'POST' && idempotent)) {
    return Boolean(
      failure.network ||
      failure.timeout ||
      status === 429 ||
      status === 502 ||
      status === 503 ||
      status === 504,
    );
  }
  return status === 429;
}

export function backoffMs(
  attempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.max(0, retryAfterMs);
  return Math.floor(random() * Math.min(8000, 500 * 2 ** attempt));
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (header === null || !header.trim()) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
