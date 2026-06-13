/**
 * @fileoverview Tests for the process-wide rate limiter: FIFO serialization,
 * minimum start-gap enforcement, and abort-during-wait.
 * @module tests/services/rate-limiter.test
 */

import { describe, expect, it } from 'vitest';
import { RateLimiter } from '@/services/musicbrainz/rate-limiter.js';

describe('RateLimiter', () => {
  it('runs tasks and returns their results', async () => {
    const limiter = new RateLimiter(1000); // 1ms gap — fast for tests
    const result = await limiter.schedule(async () => 42);
    expect(result).toBe(42);
  });

  it('serializes concurrent tasks in FIFO order', async () => {
    const limiter = new RateLimiter(1000);
    const order: number[] = [];
    await Promise.all([
      limiter.schedule(async () => {
        order.push(1);
      }),
      limiter.schedule(async () => {
        order.push(2);
      }),
      limiter.schedule(async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('enforces a minimum gap between consecutive task starts', async () => {
    const gapMs = 40;
    const limiter = new RateLimiter(1000 / gapMs); // → 40ms gap
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all([
      limiter.schedule(async () => {
        starts.push(Date.now() - t0);
      }),
      limiter.schedule(async () => {
        starts.push(Date.now() - t0);
      }),
    ]);
    // Second start is at least one gap after the first (minus timer slack).
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(gapMs - 10);
  });

  it('rejects a queued task when its signal aborts before dispatch', async () => {
    const limiter = new RateLimiter(2); // 500ms gap so the 2nd task waits
    const controller = new AbortController();
    // First task occupies the limiter; second waits behind the gap.
    const first = limiter.schedule(async () => 'first');
    const second = limiter.schedule(async () => 'second', controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(second).rejects.toThrow('cancelled');
    await expect(first).resolves.toBe('first');
  });
});
