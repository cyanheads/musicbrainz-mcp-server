/**
 * @fileoverview Tests for the get_cover_art tool: image mapping, the empty-set
 * (no-art) success notice, and invalid_mbid mapping.
 * @module tests/tools/get-cover-art.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getImagesMock = vi.fn();

vi.mock('@/services/cover-art/cover-art-service.js', () => ({
  getCoverArtService: () => ({ getImages: getImagesMock }),
}));

const { getCoverArtTool } = await import('@/mcp-server/tools/definitions/get-cover-art.tool.js');

afterEach(() => getImagesMock.mockReset());

describe('get_cover_art', () => {
  it('maps images with thumbnails and surfaces hasArt enrichment', async () => {
    getImagesMock.mockResolvedValueOnce({
      images: [
        {
          id: 42,
          image: 'https://caa/x/42.jpg',
          front: true,
          back: false,
          types: ['Front'],
          thumbnails: { '500': 'https://caa/500.jpg' },
        },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const input = getCoverArtTool.input.parse({ mbid: 'rel-mbid' });
    const result = await getCoverArtTool.handler(input, ctx);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      id: '42',
      front: true,
      thumbnail500: 'https://caa/500.jpg',
    });
    expect(getEnrichment(ctx).hasArt).toBe(true);
  });

  it('returns an empty set with a notice when no art exists', async () => {
    getImagesMock.mockResolvedValueOnce({ images: [] });
    const ctx = createMockContext({ tenantId: 'test' });
    const input = getCoverArtTool.input.parse({ mbid: 'no-art' });
    const result = await getCoverArtTool.handler(input, ctx);
    expect(result.images).toEqual([]);
    expect(getEnrichment(ctx).hasArt).toBe(false);
    expect(getEnrichment(ctx).notice).toContain('No cover art');
  });

  it('surfaces the representative release for a release-group query', async () => {
    getImagesMock.mockResolvedValueOnce({
      images: [{ id: 1, image: 'u', front: true, back: false, types: [] }],
      release: 'https://mb/release/rep-mbid',
    });
    const ctx = createMockContext({ tenantId: 'test' });
    const input = getCoverArtTool.input.parse({ mbid: 'rg-mbid', entity_type: 'release-group' });
    const result = await getCoverArtTool.handler(input, ctx);
    expect(result.representativeRelease).toBe('rep-mbid');
  });

  it('maps an upstream 400 to ctx.fail("invalid_mbid")', async () => {
    getImagesMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidParams, 'bad'));
    const ctx = createMockContext({ tenantId: 'test', errors: getCoverArtTool.errors });
    const input = getCoverArtTool.input.parse({ mbid: '0' });
    await expect(getCoverArtTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_mbid' },
    });
  });
});
