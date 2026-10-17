import { YouGileError } from './errors.js';
type Waiter = {
  resolve: () => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};
export class RateLimiter {
  private tokens: number;
  private updated: number;
  private pauseUntil = 0;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    readonly perMinute: number,
    readonly now: () => number = Date.now,
  ) {
    this.tokens = Math.ceil(perMinute / 4);
    this.updated = now();
  }
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new YouGileError('Request timed out', 'timeout'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          this.queue = this.queue.filter((w) => w !== waiter);
          reject(new YouGileError('Request timed out', 'timeout'));
          this.pump();
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.queue.push(waiter);
      this.pump();
    });
  }
  penalize(ms: number): void {
    this.refill();
    this.tokens = 0;
    this.pauseUntil = Math.max(this.pauseUntil, this.now() + Math.max(0, ms));
    this.updated = this.pauseUntil;
    this.pump();
  }
  private refill(): void {
    const now = this.now();
    if (now > this.pauseUntil) {
      const refillStart = Math.max(this.updated, this.pauseUntil);
      this.tokens = Math.min(
        Math.ceil(this.perMinute / 4),
        this.tokens + (Math.max(0, now - refillStart) * this.perMinute) / 60000,
      );
    }
    this.updated = now;
  }
  private pump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.refill();
    while (this.queue.length && this.tokens >= 1 && this.now() >= this.pauseUntil) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) {
        if (waiter.abort) waiter.abort();
        continue;
      }
      this.tokens -= 1;
      if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.resolve();
    }
    if (this.queue.length) {
      const delay = Math.max(
        1,
        this.now() < this.pauseUntil
          ? this.pauseUntil - this.now()
          : ((1 - this.tokens) * 60000) / this.perMinute,
      );
      this.timer = setTimeout(() => this.pump(), delay);
    }
  }
}
