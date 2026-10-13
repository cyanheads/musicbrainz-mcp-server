/**
 * @fileoverview Tests for CoverArtService: 404 → empty set flagged `found: false`,
 * happy-path image parsing, 400 reclassification, and the response cache
 * (storage-safe keys; a cached 404 keeps its `found: false`). `fetchWithTimeout`
 * is mocked; the real HTTP path is covered in `cover-art-http.test.ts`.
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

afterEach(() => fetchMock.mockReset());

describe('CoverArtService', () => {
  it.each(['not-a-uuid', '00000000-0000-0000-0000-000000000000'])(
    'rejects %s before CAA fetch',
    async (mbid) => {
      fetchMock.mockResolvedValueOnce({ text: async () => '{"images":[]}' });
      await expect(
        makeService().getImages('release', mbid, createMockContext()),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('maps a 404 to an empty image set flagged found=false (no art is not an error)', async () => {
    fetchMock.mockRejectedValueOnce(notFound('Not Found'));
    const ctx = createMockContext({ tenantId: 'test' });
    const result = await makeService().getImages(
      'release',
      'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      ctx,
    );
    expect(result).toEqual({ images: [], found: false });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ requestId: ctx.requestId, operation: 'CoverArtRequest' }),
      expect.objectContaining({ expectedStatuses: [404] }),
    );
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
    const result = await makeService().getImages(
      'release-group',
      'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      ctx,
    );
    expect(result.images?.[0]?.front).toBe(true);
    expect(result.images?.[0]?.thumbnails?.['250']).toBe('https://caa.test/250.jpg');
    expect(result.release).toContain('rep-mbid');
  });

  it('reclassifies an upstream 400 as ValidationError', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    fetchMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidParams, 'bad'));
    const ctx = createMockContext({ tenantId: 'test' });
    await expect(
      makeService().getImages('release', 'a74b1b7f-71a5-4011-9441-d0b5e4122711', ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const first = await service.getImages('release', 'a74b1b7f-71a5-4011-9441-d0b5e4122711', ctx);
    const second = await service.getImages('release', 'a74b1b7f-71a5-4011-9441-d0b5e4122711', ctx);
    expect(second).toEqual(first);
    expect(first.found).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
  });

  // A cached 404 must stay distinguishable from a 200 on the cache hit, or a
  // caller that verifies the MBID on a 404 would skip that check for the TTL.
  it('keeps found=false on a cache hit for a cached 404', async () => {
    fetchMock.mockRejectedValueOnce(notFound('Not Found'));
    const ctx = realStorageContext();
    const service = makeService(3600);
    const first = await service.getImages('release', 'a74b1b7f-71a5-4011-9441-d0b5e4122711', ctx);
    const second = await service.getImages('release', 'a74b1b7f-71a5-4011-9441-d0b5e4122711', ctx);
    expect(first).toEqual({ images: [], found: false });
    expect(second).toEqual({ images: [], found: false });
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
  });
});
