/**
 * @fileoverview Process-wide request rate limiter for the MusicBrainz Web
 * Service. MusicBrainz enforces ~1 request/second per IP across its whole
 * hosted instance and returns HTTP 503 + `Retry-After` when exceeded, so a
 * client-side limiter is mandatory: on a hosted multi-tenant deployment every
 * tenant shares one limiter or concurrent callers starve each other.
 *
 * Implemented as a minimum-start-gap serializer (a token bucket of capacity 1,
 * refilling one token every `1000 / rps` ms). Calls are dispatched one at a time
 * with at least `minGapMs` between consecutive starts; concurrent callers queue
 * FIFO. Waiting tasks honor an optional `AbortSignal` so a caller's cancellation
 * or deadline bounds queue time end-to-end rather than sitting behind a backlog.
 * @module services/musicbrainz/rate-limiter
 */

/**
 * Serializes upstream calls to a fixed maximum start-rate. One instance is
 * shared process-wide by the MusicBrainz service.
 */
export class RateLimiter {
  private readonly minGapMs: number;
  /** Tail of the dispatch chain — each scheduled call awaits the previous one's gap. */
  private chain: Promise<void> = Promise.resolve();

  constructor(requestsPerSecond: number) {
    this.minGapMs = requestsPerSecond > 0 ? 1000 / requestsPerSecond : 0;
  }

  /**
   * Schedule `task` behind any already-queued calls, enforcing the minimum gap
   * between consecutive starts. Rejects with `signal.reason` if the signal
   * aborts while still waiting in the queue (the in-flight `task` forwards its
   * own signal to downstream I/O).
   */
  async schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const waitForTurn = this.chain;
    let releaseGap!: () => void;
    // Extend the chain immediately so the next caller waits for THIS call's gap,
    // before we ever await — keeps scheduling order deterministic under concurrency.
    this.chain = new Promise<void>((resolve) => {
      releaseGap = resolve;
    });

    try {
      await waitForTurn;
      if (signal?.aborted) throw signal.reason;
      return await task();
    } finally {
      // Release the next caller after the gap elapses. Detached from the task's
      // own completion: the gap is measured from this call's start, and the timer
      // must not be cancelled by the caller's signal (that would stall the queue).
      setTimeout(releaseGap, this.minGapMs);
    }
  }
}
