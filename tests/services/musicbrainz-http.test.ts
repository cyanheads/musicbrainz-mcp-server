/**
 * @fileoverview Upstream HTTP boundary tests for MusicBrainzService. The sibling
 * `musicbrainz-service.test.ts` mocks `fetchWithTimeout`, which skips the
 * framework's own status classification and error construction. Here only
 * `globalThis.fetch` is faked, so the real `fetchWithTimeout` /
 * `httpErrorFromResponse` path runs and these pin what a non-2xx actually
 * produces — including the request URL staying off client-facing `error.data`.
 * @module tests/services/musicbrainz-http.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MusicBrainzService } from '@/services/musicbrainz/musicbrainz-service.js';
import { RateLimiter } from '@/services/musicbrainz/rate-limiter.js';

const BASE = 'https://mb.test/ws/2';

/**
 * No cache, fast limiter. Defaults to no retries so a failure surfaces on the
 * first attempt; the per-call-bound tests configure retries/timeout explicitly.
 */
function makeService({ timeoutMs = 5000, maxRetries = 0 } = {}) {
  return new MusicBrainzService(
    BASE,
    'test@example.com',
    '0.1.0',
    new RateLimiter(1000),
    0,
    timeoutMs,
    maxRetries,
  );
}

/** A fetch that never answers until its signal aborts — a stalled upstream socket. */
function stalledFetch(): typeof fetch {
  return ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
}

let http: ReturnType<typeof createFetchMock> | undefined;

afterEach(() => {
  http?.restore();
  http = undefined;
  vi.unstubAllGlobals();
});

describe('MusicBrainzService upstream HTTP boundary', () => {
  it('reclassifies an upstream 400 to ValidationError', async () => {
    http = createFetchMock([
      {
        match: (request) => request.url.startsWith(`${BASE}/artist/`),
        respond: () => new Response('Invalid mbid.', { status: 400 }),
      },
    ]);
    http.install();

    await expect(
      makeService().lookup(
        'artist',
        'not-a-uuid',
        { inc: [] },
        createMockContext({ tenantId: 't' }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('keeps the upstream request URL off the error data a client would receive', async () => {
    http = createFetchMock([
      {
        match: (request) => request.url.startsWith(`${BASE}/artist/`),
        respond: () => new Response('Invalid mbid.', { status: 400 }),
      },
    ]);
    http.install();

    // The query string routinely carries caller input; `httpErrorFromResponse`
    // no longer copies it onto `error.data` unless `includeUrl: true` is passed.
    let data: Record<string, unknown> | undefined;
    try {
      await makeService().lookup(
        'artist',
        'secret-lookup-value',
        { inc: ['tags'] },
        createMockContext({ tenantId: 't' }),
      );
      expect.unreachable('the 400 should have rejected');
    } catch (error) {
      data = (error as { data?: Record<string, unknown> }).data;
    }

    // Guard against a vacuous pass: `data` must be populated for the absence of
    // `url` to mean anything.
    expect(data).toBeTypeOf('object');
    expect(Object.keys(data ?? {}).length).toBeGreaterThan(0);
    expect(data).not.toHaveProperty('url');
    expect(JSON.stringify(data)).not.toContain('secret-lookup-value');
  });

  it('maps a 404 to NotFound so the tool contract can report entity_not_found', async () => {
    http = createFetchMock([
      {
        match: (request) => request.url.startsWith(`${BASE}/artist/`),
        respond: () => new Response('Not Found', { status: 404 }),
      },
    ]);
    http.install();

    await expect(
      makeService().lookup(
        'artist',
        '00000000-0000-0000-0000-000000000000',
        { inc: [] },
        createMockContext({ tenantId: 't' }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('sends the descriptive User-Agent MusicBrainz requires on the real request', async () => {
    http = createFetchMock([
      {
        match: (request) => request.url.startsWith(`${BASE}/artist/`),
        respond: () => Response.json({ id: 'abc', name: 'Radiohead' }),
      },
    ]);
    http.install();

    await makeService().lookup('artist', 'abc', { inc: [] }, createMockContext({ tenantId: 't' }));

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.request.headers.get('User-Agent')).toBe(
      'musicbrainz-mcp-server/0.1.0 ( test@example.com )',
    );
  });

  it('classifies an upstream 503 as a transient ServiceUnavailable', async () => {
    http = createFetchMock([
      {
        match: (request) => request.url.startsWith(`${BASE}/artist/`),
        respond: () => new Response('Rate limited', { status: 503 }),
      },
    ]);
    http.install();

    await expect(
      makeService().lookup('artist', 'abc', { inc: [] }, createMockContext({ tenantId: 't' })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  });

  it('honors a per-call maxRetries=0 — a transient 503 is attempted exactly once', async () => {
    http = createFetchMock([
      {
        match: (request) => request.url.startsWith(`${BASE}/release/`),
        respond: () => new Response('Rate limited', { status: 503 }),
      },
    ]);
    http.install();

    await expect(
      makeService({ maxRetries: 1 }).lookup(
        'release',
        'abc',
        { inc: [] },
        createMockContext({ tenantId: 't' }),
        { maxRetries: 0 },
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(http.calls).toHaveLength(1);
  });

  it('honors a per-call timeoutMs tighter than the configured timeout', async () => {
    vi.stubGlobal('fetch', stalledFetch());
    const started = Date.now();

    await expect(
      makeService({ timeoutMs: 30_000 }).lookup(
        'release',
        'abc',
        { inc: [] },
        createMockContext({ tenantId: 't' }),
        { timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 2_000);
});
