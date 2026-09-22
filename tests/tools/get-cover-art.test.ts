/**
 * @fileoverview Tests for the get_cover_art tool handler with both services
 * stubbed at the accessor: image mapping (full and sparse), the no-art success
 * notice, invalid_mbid mapping, and the call-site shape of the MBID check made
 * after a Cover Art Archive 404. The check's upstream behavior (status mapping,
 * bounds honored, cache) is covered at the HTTP seam in
 * `get-cover-art-verification.test.ts`.
 * @module tests/tools/get-cover-art.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getImagesMock = vi.fn();
const lookupMock = vi.fn();

vi.mock('@/services/cover-art/cover-art-service.js', () => ({
  getCoverArtService: () => ({ getImages: getImagesMock }),
}));

vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({ lookup: lookupMock }),
}));

const { getCoverArtTool } = await import('@/mcp-server/tools/definitions/get-cover-art.tool.js');

afterEach(() => {
  getImagesMock.mockReset();
  lookupMock.mockReset();
});

const textOf = (blocks: { type: string; text?: string }[]) =>
  blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');

describe('get_cover_art', () => {
  it('maps images with thumbnails and surfaces hasArt enrichment', async () => {
    getImagesMock.mockResolvedValueOnce({
      found: true,
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
    const ctx = createMockContext({ tenantId: 'test', errors: getCoverArtTool.errors });
    const input = getCoverArtTool.input.parse({ mbid: 'rel-mbid' });
    const result = await getCoverArtTool.handler(input, ctx);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      id: '42',
      front: true,
      thumbnail500: 'https://caa/500.jpg',
    });
    expect(getEnrichment(ctx).hasArt).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('keeps a sparse image record honest (omitted fields stay absent) and renders it', async () => {
    getImagesMock.mockResolvedValueOnce({
      found: true,
      images: [{ id: 7, image: 'https://caa/7.jpg' }],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getCoverArtTool.errors });
    const result = await getCoverArtTool.handler(
      getCoverArtTool.input.parse({ mbid: 'rel-mbid' }),
      ctx,
    );

    expect(result.images[0]).toEqual({
      id: '7',
      front: false,
      back: false,
      types: [],
      imageUrl: 'https://caa/7.jpg',
    });
    expect(() => getCoverArtTool.output.parse(result)).not.toThrow();
    const text = textOf(getCoverArtTool.format?.(result) ?? []);
    expect(text).toContain('### Image 7');
    expect(text).toContain('https://caa/7.jpg');
    expect(text).not.toContain('250px');
  });

  it('on a CAA 404, checks the MBID with a bounded, bare lookup of the same entity type', async () => {
    getImagesMock.mockResolvedValueOnce({ found: false, images: [] });
    lookupMock.mockResolvedValueOnce({ id: 'no-art' });
    const ctx = createMockContext({ tenantId: 'test', errors: getCoverArtTool.errors });
    const input = getCoverArtTool.input.parse({ mbid: 'no-art', entity_type: 'release-group' });
    const result = await getCoverArtTool.handler(input, ctx);

    expect(result.images).toEqual([]);
    expect(getEnrichment(ctx).hasArt).toBe(false);
    expect(getEnrichment(ctx).notice).toContain('No cover art');
    expect(lookupMock).toHaveBeenCalledWith(
      'release-group',
      'no-art',
      { inc: [] },
      ctx,
      expect.objectContaining({ maxRetries: 0, timeoutMs: expect.any(Number) }),
    );
    const text = textOf(getCoverArtTool.format?.(result) ?? []);
    expect(text).toContain('Cover art: release-group no-art');
    expect(text).toContain('No cover art available');
  });

  it('rethrows a non-upstream failure from the MBID check instead of reporting "unconfirmed"', async () => {
    getImagesMock.mockResolvedValueOnce({ found: false, images: [] });
    lookupMock.mockRejectedValueOnce(new TypeError('boom'));
    const ctx = createMockContext({ tenantId: 'test', errors: getCoverArtTool.errors });
    await expect(
      getCoverArtTool.handler(getCoverArtTool.input.parse({ mbid: 'no-art' }), ctx),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('surfaces the representative release for a release-group query', async () => {
    getImagesMock.mockResolvedValueOnce({
      found: true,
      images: [{ id: 1, image: 'u', front: true, back: false, types: [] }],
      release: 'https://mb/release/rep-mbid',
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getCoverArtTool.errors });
    const input = getCoverArtTool.input.parse({ mbid: 'rg-mbid', entity_type: 'release-group' });
    const result = await getCoverArtTool.handler(input, ctx);
    expect(result.representativeRelease).toBe('rep-mbid');
  });

  it('maps an upstream 400 to ctx.fail("invalid_mbid") without checking MusicBrainz', async () => {
    getImagesMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.ValidationError, 'bad'));
    const ctx = createMockContext({ tenantId: 'test', errors: getCoverArtTool.errors });
    const input = getCoverArtTool.input.parse({ mbid: '0' });
    await expect(getCoverArtTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_mbid' },
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
