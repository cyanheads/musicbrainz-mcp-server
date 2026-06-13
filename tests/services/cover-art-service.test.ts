/**
 * @fileoverview Tests for CoverArtService: 404 → clean empty set, happy-path
 * image parsing, and transient HTML-error handling. `fetchWithTimeout` is mocked.
 * @module tests/services/cover-art-service.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async (importActual) => {
  const actual = await importActual<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: fetchMock };
});

const { CoverArtService } = await import('@/services/cover-art/cover-art-service.js');

function makeService(cacheTtl = 0) {
  return new CoverArtService('https://caa.test', 5000, 0, cacheTtl);
}

/**
 * Context whose `ctx.state` routes through the production `StorageService`, which
 * enforces the storage key allowlist. The CAA cache key joins its prefix with a
 * separator the allowlist rejects unless sanitized — this seam proves the key is
 * storage-safe (a plain mock context's Map-backed state skips validation).
 */
function realStorageContext(tenantId = 'test'): Context {
  const ctx = createMockContext({ tenantId });
  const storage = createInMemoryStorage();
  const tenantCtx = { tenantId, requestId: ctx.requestId };
  return {
    ...ctx,
    state: {
      ...ctx.state,
      get: (key, schema) => storage.get(key, tenantCtx).then((v) => (schema ? schema.parse(v) : v)),
      set: (key, value, opts) =>
        storage.set(key, value, tenantCtx, opts?.ttl !== undefined ? { ttl: opts.ttl } : undefined),
    },
  } as Context;
}

afterEach(() => fetchMock.mockReset());

describe('CoverArtService', () => {
  it('maps a 404 to an empty image set (no art is not an error)', async () => {
    fetchMock.mockRejectedValueOnce(notFound('Not Found'));
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await makeService().getImages('release', 'no-art-mbid', ctx);
    expect(result).toEqual({ images: [] });
  });

  it('parses images with thumbnails and the representative release', async () => {
    fetchMock.mockResolvedValueOnce({
      text: async () =>
        JSON.stringify({
          images: [
            {
              id: 123,
              image: 'https://caa.test/release/x/123.jpg',
              front: true,
              back: false,
              types: ['Front'],
              thumbnails: { '250': 'https://caa.test/250.jpg' },
            },
          ],
          release: 'https://mb.test/release/rep-mbid',
        }),
    } as Response);
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await makeService().getImages('release-group', 'rg-mbid', ctx);
    expect(result.images?.[0]?.front).toBe(true);
    expect(result.images?.[0]?.thumbnails?.['250']).toBe('https://caa.test/250.jpg');
    expect(result.release).toContain('rep-mbid');
  });

  it('rethrows a non-404 error (e.g. malformed MBID 400)', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    fetchMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidParams, 'bad'));
    const ctx = createMockContext({ tenantId: 'test' });
    await expect(makeService().getImages('release', 'bad', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
  });

  // Regression: the cache key must satisfy the storage key allowlist. Caching an
  // image lookup against a real key-validating StorageService must not throw a
  // key-validation error (a plain mock context's state skips validation).
  it('caches an image lookup through real key-validating storage without a key error', async () => {
    fetchMock.mockResolvedValueOnce({
      text: async () => JSON.stringify({ images: [{ id: 1, image: 'u', front: true }] }),
    } as Response);
    const ctx = realStorageContext();
    const service = makeService(3600);
    const first = await service.getImages('release', 'mbid-abc', ctx);
    const second = await service.getImages('release', 'mbid-abc', ctx);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
  });
});
