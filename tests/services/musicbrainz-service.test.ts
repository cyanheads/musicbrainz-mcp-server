/**
 * @fileoverview Tests for MusicBrainzService: JSON parsing, HTML-error-page
 * detection (transient), 404 bubbling (non-transient), and response caching.
 * `fetchWithTimeout` is mocked; `withRetry` and the limiter run for real.
 * @module tests/services/musicbrainz-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: fetchMock };
});

const { MusicBrainzService } = await import('@/services/musicbrainz/musicbrainz-service.js');
const { RateLimiter } = await import('@/services/musicbrainz/rate-limiter.js');

/** Build a service with a fast limiter and no retries (so transient throws surface immediately). */
function makeService(cacheTtl = 0) {
  return new MusicBrainzService(
    'https://mb.test/ws/2',
    'test@example.com',
    '0.1.0',
    new RateLimiter(1000),
    cacheTtl,
    5000,
    0, // maxRetries = 0
  );
}

function jsonResponse(body: unknown) {
  return { text: async () => JSON.stringify(body) } as Response;
}

/**
 * A context whose `ctx.state` routes through the production `StorageService`
 * (which enforces the storage key allowlist `[a-zA-Z0-9_.\-/]` via `validateKey`)
 * instead of the permissive `Map` in `createMockContext`. Cache keys built from a
 * WS/2 path — `?`, `=`, `&`, `+`, and a `:` separator — would throw a `-32007`
 * ValidationError here if not sanitized, so this is the seam that proves the
 * cache key is storage-safe (a plain mock context masks it).
 */
function realStorageContext(tenantId = 'test'): Context {
  const ctx = createMockContext({ tenantId });
  const storage = createInMemoryStorage();
  return {
    ...ctx,
    state: {
      ...ctx.state,
      get: (key, schema) => storage.get(key, ctx).then((v) => (schema ? schema.parse(v) : v)),
      set: (key, value, opts) =>
        storage.set(key, value, ctx, opts?.ttl !== undefined ? { ttl: opts.ttl } : undefined),
    },
  } as Context;
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('MusicBrainzService', () => {
  it('parses a JSON lookup response and sends the descriptive User-Agent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'abc', name: 'Radiohead' }));
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await makeService().lookup<{ id: string; name: string }>(
      'artist',
      'abc',
      { inc: ['tags'] },
      ctx,
    );
    expect(result).toEqual({ id: 'abc', name: 'Radiohead' });
    const [url, , , options] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/artist/abc');
    expect(url).toContain('inc=tags');
    expect(url).toContain('fmt=json');
    expect((options.headers as Record<string, string>)['User-Agent']).toBe(
      'musicbrainz-mcp-server/0.1.0 ( test@example.com )',
    );
  });

  it('throws ServiceUnavailable when the upstream returns an HTML error page', async () => {
    fetchMock.mockResolvedValueOnce({
      text: async () => '<!DOCTYPE html><html><body>503</body></html>',
    } as Response);
    const ctx = createMockContext({ tenantId: 'test' });
    await expect(makeService().lookup('artist', 'abc', { inc: [] }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('bubbles a 404 NotFound from the fetch layer unchanged', async () => {
    fetchMock.mockRejectedValueOnce(notFound('Not Found'));
    const ctx = createMockContext({ tenantId: 'test' });
    await expect(
      makeService().lookup('artist', '00000000-0000-0000-0000-000000000000', { inc: [] }, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it('serves a cached response on the second call without re-fetching', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'abc', name: 'Cached' }));
    const ctx = createMockContext({ tenantId: 'test' });
    const service = makeService(3600);
    const first = await service.lookup('artist', 'abc', { inc: [] }, ctx);
    const second = await service.lookup('artist', 'abc', { inc: [] }, ctx);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys the cache on the inc set (different inc → separate fetch)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'abc', v: 1 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'abc', v: 2 }));
    const ctx = createMockContext({ tenantId: 'test' });
    const service = makeService(3600);
    await service.lookup('artist', 'abc', { inc: ['tags'] }, ctx);
    await service.lookup('artist', 'abc', { inc: ['genres'] }, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requests inc=artist-credits on the ISRC endpoint so the artist credit is populated', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        isrc: 'USRC17607839',
        recordings: [
          {
            id: 'rec1',
            title: 'Crazy Eyes',
            'artist-credit': [{ name: 'Daryl Hall & John Oates' }],
          },
        ],
      }),
    );
    const ctx = createMockContext({ tenantId: 'test' });
    await makeService().resolveIsrc('USRC17607839', ctx);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/isrc/USRC17607839');
    expect(url).toContain('inc=artist-credits');
    expect(url).toContain('fmt=json');
  });

  it('builds the search path with query/limit/offset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, artists: [] }));
    const ctx = createMockContext({ tenantId: 'test' });
    await makeService().search('artist', 'radiohead', { limit: 10, offset: 5 }, ctx);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/artist?');
    expect(url).toContain('query=radiohead');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=5');
  });

  it('does not retry a non-transient error (maxRetries=0)', async () => {
    fetchMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidParams, 'Invalid mbid.'));
    const ctx = createMockContext({ tenantId: 'test' });
    await expect(makeService().lookup('artist', 'zero', { inc: [] }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Regression: the cache key is built from the WS/2 path, which carries `?`,
  // `=`, `&` (and `+` between inc tokens) plus a separator — none of which the
  // storage key allowlist permits. Caching against a real StorageService must
  // not throw a key-validation error, or every cached call fails. (The plain
  // mock context's Map-backed state skips validation and hid this.)
  it('caches a search through real key-validating storage without a key error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 1, artists: [{ id: 'abc' }] }));
    const ctx = realStorageContext();
    const service = makeService(3600);
    const first = await service.search('artist', 'Radiohead', { limit: 3, offset: 0 }, ctx);
    const second = await service.search('artist', 'Radiohead', { limit: 3, offset: 0 }, ctx);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
  });

  it('caches an inc lookup (path with + and ?) through real storage without a key error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'abc', name: 'Radiohead' }));
    const ctx = realStorageContext();
    const service = makeService(3600);
    const first = await service.lookup(
      'artist',
      'abc',
      { inc: ['release-groups', 'url-rels'] },
      ctx,
    );
    const second = await service.lookup(
      'artist',
      'abc',
      { inc: ['release-groups', 'url-rels'] },
      ctx,
    );
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
