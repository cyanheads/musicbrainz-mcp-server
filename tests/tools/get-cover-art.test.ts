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
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  it('keeps image clamping independent of the disabled search/browse clamp', async () => {
    vi.stubEnv('MUSICBRAINZ_CLAMP_OVERSIZED_LIMITS', 'off');
    try {
      getImagesMock.mockResolvedValueOnce({
        found: true,
        images: [{ id: 1, image: 'https://caa/1.jpg' }],
      });
      const result = await runToolContract(getCoverArtTool, { mbid: 'rel', limit: 101, offset: 0 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        totalCount: 1,
        offset: 0,
        images: [{ id: '1' }],
        notice: expect.stringContaining('applied limit=100'),
      });
      expect(textOf(result.content ?? [])).toContain('applied limit=100');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    { offset: undefined, limit: undefined, shown: 25, next: 25 },
    { offset: 25, limit: 10, shown: 10, next: 35 },
    { offset: 102, limit: 25, shown: 1, next: undefined },
    { offset: 103, limit: 25, shown: 0, next: undefined },
    { offset: 200, limit: 25, shown: 0, next: undefined },
    { offset: 0, limit: 101, shown: 100, next: 100 },
    { offset: 200, limit: 101, shown: 0, next: undefined },
  ])(
    'pages archive images at $offset with limit $limit',
    async ({ offset, limit, shown, next }) => {
      const raw = {
        found: true,
        images: Array.from({ length: 103 }, (_, i) => ({
          id: i,
          image: `https://caa/${i}.jpg`,
          thumbnails: {
            '250': `https://caa/${i}-250.jpg`,
            '500': `https://caa/${i}-500.jpg`,
            '1200': `https://caa/${i}-1200.jpg`,
          },
        })),
      };
      getImagesMock.mockResolvedValue(raw);
      const before = JSON.stringify(raw);
      const result = await runToolContract(getCoverArtTool, {
        mbid: 'rel',
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      });
      expect(result.isError).not.toBe(true);
      const data = result.structuredContent as {
        images: {
          id: string;
          imageUrl: string;
          thumbnail250: string;
          thumbnail500: string;
          thumbnail1200: string;
        }[];
        totalCount: number;
        hasArt: boolean;
        notice?: string;
        truncated?: boolean;
      };
      expect(data).toMatchObject({ offset: offset ?? 0, totalCount: 103, hasArt: true });
      expect(data.images).toHaveLength(shown);
      const expectedImages = Array.from({ length: shown }, (_, index) => {
        const id = (offset ?? 0) + index;
        return {
          id: String(id),
          imageUrl: `https://caa/${id}.jpg`,
          thumbnail250: `https://caa/${id}-250.jpg`,
          thumbnail500: `https://caa/${id}-500.jpg`,
          thumbnail1200: `https://caa/${id}-1200.jpg`,
        };
      });
      expect(data.images).toMatchObject(expectedImages);
      const text = textOf(result.content ?? []);
      expect(text).toContain(`offset: ${offset ?? 0}, shown: ${shown}`);
      expect(text).toContain('103 total');
      if (limit === 101) expect(data.notice).toContain('101');
      if (limit === 101) expect(data.notice).toContain('100');
      if (next !== undefined) {
        expect(data).toMatchObject({ truncated: true, shown, cap: Math.min(limit ?? 25, 100) });
        expect(data.notice).toContain(`offset=${next}`);
      } else {
        expect(data.truncated).toBeUndefined();
        expect(data.notice ?? '').not.toContain('Continue with');
        if (shown === 0) {
          expect(data.notice).toContain('exhausted');
          expect(text).toContain('page is empty');
          expect(text).not.toContain('No cover art available for this entity');
          expect(text).not.toContain('No cover art exists');
        }
      }
      for (const img of expectedImages) {
        for (const url of [img.imageUrl, img.thumbnail250, img.thumbnail500, img.thumbnail1200])
          expect(text).toContain(url);
      }
      if (data.notice) expect(text).toContain(data.notice);
      expect(getImagesMock).toHaveBeenCalledTimes(1);
      expect(lookupMock).not.toHaveBeenCalled();
      expect(JSON.stringify(raw)).toBe(before);
    },
  );
  it.each([{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: -1 }, { limit: 1.5 }])(
    'rejects invalid window arguments %j before archive lookup',
    async (args) => {
      const result = await runToolContract(getCoverArtTool, { mbid: 'rel', ...args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_arguments', recovery: { hint: expect.any(String) } } },
      });
      expect(textOf(result.content ?? [])).toContain('reason invalid_arguments');
      expect(getImagesMock).not.toHaveBeenCalled();
    },
  );
  it('combines a clamp with a genuine no-art notice once', async () => {
    getImagesMock.mockResolvedValueOnce({ found: false, images: [] });
    lookupMock.mockResolvedValueOnce({ id: 'rel' });
    const result = await runToolContract(getCoverArtTool, { mbid: 'rel', limit: 101 });
    expect(result.structuredContent).toMatchObject({
      images: [],
      hasArt: false,
      totalCount: 0,
      offset: 0,
      notice: expect.stringContaining('101'),
    });
    expect(textOf(result.content ?? [])).toContain('No cover art exists');
    expect((result.structuredContent as { notice: string }).notice).not.toContain('exhausted');
  });
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
