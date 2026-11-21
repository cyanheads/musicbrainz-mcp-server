/**
 * @fileoverview Release media windows retain ordered tracks, whole-release totals and raw resources.
 * @module tests/tools/get-release.test
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawRelease } from '@/services/musicbrainz/types.js';

const lookup = vi.fn();
vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({ lookup }),
}));
const { getReleaseTool } = await import('@/mcp-server/tools/definitions/get-release.tool.js');
const { entityResource } = await import('@/mcp-server/resources/definitions/entity.resource.js');
const mbid = 'd996abaa-ce14-45c7-944a-9c62adee19fe';
afterEach(() => lookup.mockReset());

describe('release media windows', () => {
  it('retains scalar edition metadata, external links and a complete selected medium', async () => {
    lookup.mockResolvedValueOnce({
      id: mbid,
      title: 'Edition',
      country: 'XE',
      date: '1997',
      barcode: '',
      relations: [
        { type: 'discogs', 'target-type': 'url', url: { resource: 'https://example.com/edition' } },
      ],
      media: [
        {
          position: 1,
          tracks: [
            { position: 1, title: 'First' },
            { position: 2, title: 'Second' },
          ],
        },
      ],
    });
    const result = await runToolContract(getReleaseTool, { mbid, media_limit: 1 });
    expect(result.structuredContent).toMatchObject({
      date: '1997',
      country: 'XE',
      externalLinks: [{ type: 'discogs', resource: 'https://example.com/edition' }],
      media: [{ tracks: [{ title: 'First' }, { title: 'Second' }] }],
    });
    expect(result.structuredContent).not.toHaveProperty('barcode');
    expect(JSON.stringify(result.content)).toContain('https://example.com/edition');
  });
  it('preserves complete and partial release events in upstream order alongside scalar date and country', async () => {
    lookup.mockResolvedValueOnce({
      id: mbid,
      date: '1997-06-16',
      country: 'XE',
      'release-events': [
        { date: '1997-06', area: { 'iso-3166-1-codes': ['FR'] } },
        { date: '1997', area: null },
        { date: null, area: { 'iso-3166-1-codes': ['DE'] } },
        { date: null, area: { name: 'Unnamed area' } },
      ],
    });
    const result = await runToolContract(getReleaseTool, { mbid });
    expect(result.structuredContent).toMatchObject({
      date: '1997-06-16',
      country: 'XE',
      releaseEvents: [{ date: '1997-06', country: 'FR' }, { date: '1997' }, { country: 'DE' }],
    });
    expect(JSON.stringify(result.content)).toContain('Release events:** 1997-06 (FR), 1997, DE');
  });

  it('requests artist and label relationships with full track data and the existing URL include', async () => {
    lookup.mockImplementationOnce(async (_type, _id, options) => ({
      id: mbid,
      relations: [
        ...(options.inc.includes('artist-rels')
          ? [
              {
                type: 'mastering',
                'target-type': 'artist',
                artist: { id: 'artist-id', name: 'Mastering Engineer', disambiguation: 'engineer' },
                attributes: ['digital'],
                direction: 'backward',
                begin: '1997',
                end: '1997-06',
                'ordering-key': 0,
              },
            ]
          : []),
        { type: 'discogs', 'target-type': 'url', url: { resource: 'https://example.com/edition' } },
        ...(options.inc.includes('label-rels')
          ? [
              {
                type: 'pressing',
                'target-type': 'label',
                label: { name: 'Pressing Plant' },
              },
            ]
          : []),
      ],
      media: [{ tracks: [{ title: 'Track One' }, { title: 'Track Two' }] }],
    }));
    const result = await runToolContract(getReleaseTool, { mbid });
    expect(result.structuredContent).toMatchObject({
      relationships: [
        {
          type: 'mastering',
          targetType: 'artist',
          targetId: 'artist-id',
          targetName: 'Mastering Engineer',
          targetDisambiguation: 'engineer',
          attributes: ['digital'],
          direction: 'backward',
          begin: '1997',
          end: '1997-06',
          orderingKey: 0,
        },
        { type: 'pressing', targetType: 'label', targetName: 'Pressing Plant' },
      ],
      externalLinks: [{ type: 'discogs', resource: 'https://example.com/edition' }],
      trackTotal: 2,
      media: [{ tracks: [{ title: 'Track One' }, { title: 'Track Two' }] }],
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(
      'mastering** (digital) backward → artist: Mastering Engineer (artist-id) — engineer [1997–1997-06] [ordering key: 0]',
    );
    expect(text).toContain('pressing** → label: Pressing Plant');
    expect(text).toContain('https://example.com/edition');
    expect(lookup).toHaveBeenCalledWith(
      'release',
      mbid,
      { inc: expect.arrayContaining(['artist-rels', 'label-rels', 'url-rels', 'recordings']) },
      expect.anything(),
      expect.anything(),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('keeps media limits unbounded when the search/browse clamp is disabled', async () => {
    vi.stubEnv('MUSICBRAINZ_CLAMP_OVERSIZED_LIMITS', 'off');
    try {
      lookup.mockResolvedValueOnce({ id: mbid, media: [{ position: 1, tracks: [] }] });
      const result = await runToolContract(getReleaseTool, {
        mbid,
        media_limit: 101,
        media_offset: 0,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        mediaTotal: 1,
        trackTotal: 0,
        media: [{ position: 1 }],
      });
      expect(JSON.stringify(result.content)).toContain('1 media, 0 tracks');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    { offset: undefined, limit: undefined, count: 20, next: 20 },
    { offset: 20, limit: 20, count: 3, next: undefined },
    { offset: 22, limit: 1, count: 1, next: undefined },
    { offset: 23, limit: 20, count: 0, next: undefined },
    { offset: 90, limit: 20, count: 0, next: undefined },
    { offset: 0, limit: 101, count: 23, next: undefined },
  ])(
    'slices normalized media at $offset with limit $limit',
    async ({ offset, limit, count, next }) => {
      const raw: RawRelease = {
        id: mbid,
        media: Array.from({ length: 23 }, (_, i) => ({
          position: i + 1,
          'track-count': 8,
          tracks: [{ position: 1, title: `Track ${i}`, recording: { id: 'repeated-recording' } }],
        })),
      };
      lookup.mockResolvedValue(raw);
      const before = JSON.stringify(raw);
      const result = await runToolContract(getReleaseTool, {
        mbid,
        ...(offset === undefined ? {} : { media_offset: offset }),
        ...(limit === undefined ? {} : { media_limit: limit }),
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        mediaTotal: 23,
        trackTotal: 23,
        mediaOffset: offset ?? 0,
      });
      const structured = result.structuredContent as {
        media: { position: number; trackCount: number }[];
        notice?: string;
        truncated?: boolean;
        shown?: number;
        cap?: number;
      };
      expect(structured.media).toHaveLength(count);
      expect(structured.media.map((m) => m.position)).toEqual(
        Array.from({ length: count }, (_, index) => (offset ?? 0) + index + 1),
      );
      for (const medium of structured.media) expect(medium.trackCount).toBe(8);
      const text = JSON.stringify(result.content);
      expect(text).toContain('23 media, 23 tracks');
      expect(text).toContain(`offset: ${offset ?? 0}, shown: ${count}`);
      if (next !== undefined) {
        expect(structured).toMatchObject({ truncated: true, shown: count, cap: limit ?? 20 });
        expect(structured.notice).toContain(`media_offset=${next}`);
        expect(text).toContain(structured.notice);
      } else {
        expect(structured.truncated).toBeUndefined();
        expect(structured.notice ?? '').not.toContain('Continue with');
        if (count === 0) {
          expect(structured.notice).toContain('exhausted');
          expect(text).toContain('exhausted');
          expect(text).not.toContain('no tracks');
        }
      }
      expect(JSON.stringify(raw)).toBe(before);
      expect(lookup).toHaveBeenCalledTimes(1);
      const resource = await entityResource.handler(
        entityResource.params!.parse({ entity_type: 'release', mbid }),
        createMockContext({ errors: entityResource.errors }),
      );
      expect(resource).toEqual(raw);
    },
  );
  it('reports an empty release without a continuation or fabricated media', async () => {
    lookup.mockResolvedValue({ id: mbid });
    const result = await runToolContract(getReleaseTool, { mbid });
    expect(result.structuredContent).toMatchObject({
      mediaTotal: 0,
      trackTotal: 0,
      mediaOffset: 0,
      media: [],
    });
    expect(JSON.stringify(result.content)).toContain('0 media, 0 tracks');
    expect(JSON.stringify(result.content)).toContain('No media');
  });
  it.each([
    { media_offset: -1 },
    { media_offset: 0.5 },
    { media_limit: 0 },
    { media_limit: -1 },
    { media_limit: 1.5 },
  ])('rejects invalid media arguments %j before lookup', async (args) => {
    const result = await runToolContract(getReleaseTool, { mbid, ...args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_arguments', recovery: { hint: expect.any(String) } } },
    });
    expect(JSON.stringify(result.content)).toContain('reason invalid_arguments');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('preserves medium order, track occurrences and upstream counts on a small release', async () => {
    lookup.mockResolvedValue({
      id: mbid,
      media: [
        {
          position: 2,
          'track-count': 3,
          tracks: [
            { position: 1, recording: { id: 'same', title: 'First', length: 61000 } },
            { position: 2, title: 'Second', recording: { id: 'same' } },
          ],
        },
        { position: 1 },
      ],
    } satisfies RawRelease);
    const result = await runToolContract(getReleaseTool, { mbid });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      media: [
        {
          position: 2,
          trackCount: 3,
          tracks: [
            { position: 1, recordingId: 'same', title: 'First', length: '1:01' },
            { position: 2, recordingId: 'same', title: 'Second' },
          ],
        },
        { position: 1, tracks: [] },
      ],
    });
    const text = JSON.stringify(result.content);
    expect(text).toMatch(/Medium 2[\s\S]*Medium 1/);
    expect(text).toContain('First (1:01)');
    expect(text).toContain('Second');
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
