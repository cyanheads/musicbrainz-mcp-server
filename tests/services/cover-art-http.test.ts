/**
 * @fileoverview Upstream HTTP boundary tests for CoverArtService. The sibling
 * `cover-art-service.test.ts` mocks `fetchWithTimeout`, which skips the real
 * status classification, retry ladder, and timeout. Here only `globalThis.fetch`
 * is faked, so these pin what a real 404 / 400 / 503 / stalled socket produces
 * and that the per-call `maxRetries` / `timeoutMs` bounds are honored by the
 * request pipeline itself — not merely passed along.
 * @module tests/services/cover-art-http.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoverArtService } from '@/services/cover-art/cover-art-service.js';

const BASE = 'https://caa.test';

function makeService({ timeoutMs = 30_000, maxRetries = 1 } = {}) {
  return new CoverArtService(BASE, timeoutMs, maxRetries, 0);
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

describe('CoverArtService upstream HTTP boundary', () => {
  it('maps a real 404 to found=false with an empty image set', async () => {
    http = createFetchMock([
      { match: `${BASE}/release/no-art`, respond: () => new Response('<html>', { status: 404 }) },
    ]);
    http.install();

    const result = await makeService().getImages(
      'release',
      'no-art',
      createMockContext({ tenantId: 't' }),
    );
    expect(result).toEqual({ images: [], found: false });
    expect(http.calls).toHaveLength(1);
  });

  it('maps a real 200 to found=true with the parsed images', async () => {
    http = createFetchMock([
      {
        match: `${BASE}/release/has-art`,
        respond: () =>
          Response.json({
            images: [{ id: 1, image: 'https://caa.test/1.jpg', front: true }],
            release: 'https://musicbrainz.org/release/has-art',
          }),
      },
    ]);
    http.install();

    const result = await makeService().getImages(
      'release',
      'has-art',
      createMockContext({ tenantId: 't' }),
    );
    expect(result.found).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(result.release).toBe('https://musicbrainz.org/release/has-art');
  });

  it('reclassifies a real 400 to ValidationError', async () => {
    http = createFetchMock([
      { match: `${BASE}/release/not-a-uuid`, respond: () => new Response('bad', { status: 400 }) },
    ]);
    http.install();

    await expect(
      makeService().getImages('release', 'not-a-uuid', createMockContext({ tenantId: 't' })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
  });

  it('retries a transient 503 up to the configured count when no per-call cap is given', async () => {
    http = createFetchMock([
      { match: `${BASE}/release-group/rg`, respond: () => new Response('down', { status: 503 }) },
    ]);
    http.install();

    await expect(
      makeService({ maxRetries: 1 }).getImages(
        'release-group',
        'rg',
        createMockContext({ tenantId: 't' }),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(http.calls).toHaveLength(2);
  });

  it('honors a per-call maxRetries=0 — a transient 503 is attempted exactly once', async () => {
    http = createFetchMock([
      { match: `${BASE}/release-group/rg`, respond: () => new Response('down', { status: 503 }) },
    ]);
    http.install();

    await expect(
      makeService({ maxRetries: 1 }).getImages(
        'release-group',
        'rg',
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
      makeService({ timeoutMs: 30_000, maxRetries: 0 }).getImages(
        'release-group',
        'rg',
        createMockContext({ tenantId: 't' }),
        { timeoutMs: 50 },
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 2_000);

  it('never loosens the configured timeout with a larger per-call value', async () => {
    vi.stubGlobal('fetch', stalledFetch());
    const started = Date.now();

    await expect(
      makeService({ timeoutMs: 50, maxRetries: 0 }).getImages(
        'release-group',
        'rg',
        createMockContext({ tenantId: 't' }),
        { timeoutMs: 30_000 },
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 2_000);
});
