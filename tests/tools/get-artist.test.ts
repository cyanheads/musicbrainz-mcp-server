/**
 * @fileoverview Tests for the get_artist tool handler: full payload, sparse
 * payload (omitted upstream fields preserved as absent), error-contract mapping
 * (invalid_mbid / entity_not_found), and discography truncation enrichment.
 * The MusicBrainz service is mocked at the accessor boundary.
 * @module tests/tools/get-artist.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawArtist, RawRelation } from '@/services/musicbrainz/types.js';

const lookupMock = vi.fn();

vi.mock('@/services/musicbrainz/musicbrainz-service.js', () => ({
  getMusicBrainzService: () => ({ lookup: lookupMock }),
  // MusicBrainzService static used by other tools — not needed here.
  MusicBrainzService: class {},
}));

const { getArtistTool } = await import('@/mcp-server/tools/definitions/get-artist.tool.js');

afterEach(() => lookupMock.mockReset());

const fullArtist: RawArtist = {
  id: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  name: 'Radiohead',
  'sort-name': 'Radiohead',
  type: 'Group',
  country: 'GB',
  area: { name: 'United Kingdom' },
  'life-span': { begin: '1991', ended: false },
  aliases: [{ name: 'レディオヘッド', locale: 'ja' }],
  tags: [{ name: 'alternative rock', count: 12 }],
  'release-groups': [
    {
      id: 'rg1',
      title: 'OK Computer',
      'primary-type': 'Album',
      'first-release-date': '1997-06-16',
    },
  ],
  relations: [
    {
      type: 'member of band',
      direction: 'backward',
      'target-type': 'artist',
      artist: { id: 'thom', name: 'Thom Yorke' },
    },
    {
      type: 'wikidata',
      'target-type': 'url',
      url: { resource: 'https://www.wikidata.org/wiki/Q26876' },
    },
  ],
};

describe('get_artist', () => {
  it('keeps the default lookup scoped to profile relationships', async () => {
    lookupMock.mockResolvedValueOnce(fullArtist);
    const result = await runToolContract(getArtistTool, { mbid: fullArtist.id });
    expect(result.isError).not.toBe(true);
    expect(lookupMock.mock.calls[0]?.[2]).toEqual({
      inc: ['aliases', 'tags', 'genres', 'release-groups', 'artist-rels', 'url-rels'],
    });
    expect(result.structuredContent).not.toHaveProperty('credits');
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(result.structuredContent).not.toHaveProperty('creditsOffset');
    expect(result.structuredContent).not.toHaveProperty('creditsNotice');
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/### Relationships[\s\S]*Thom Yorke[\s\S]*### External links/),
    });
  });

  it('maps a full payload, splitting relationships and url-rels', async () => {
    lookupMock.mockResolvedValueOnce(fullArtist);
    const ctx = createMockContext({ tenantId: 'test', errors: getArtistTool.errors });
    const input = getArtistTool.input.parse({ mbid: fullArtist.id });
    const result = await getArtistTool.handler(input, ctx);

    expect(result.name).toBe('Radiohead');
    expect(result.country).toBe('GB');
    expect(result.area).toBe('United Kingdom');
    expect(result.lifeSpan).toEqual({ begin: '1991', ended: false });
    expect(result.releaseGroups).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]).toMatchObject({ type: 'member of band', targetId: 'thom' });
    expect(result.externalLinks).toEqual([
      { type: 'wikidata', resource: 'https://www.wikidata.org/wiki/Q26876' },
    ]);
  });

  it('preserves absence on a sparse payload (omitted fields stay absent, not fabricated)', async () => {
    // Minimal upstream record — only id + name present.
    lookupMock.mockResolvedValueOnce({
      id: 'sparse-mbid',
      name: 'Obscure Artist',
    } satisfies RawArtist);
    const ctx = createMockContext({ tenantId: 'test', errors: getArtistTool.errors });
    const input = getArtistTool.input.parse({ mbid: 'sparse-mbid' });
    const result = await getArtistTool.handler(input, ctx);

    expect(result.name).toBe('Obscure Artist');
    expect(result).not.toHaveProperty('country');
    expect(result).not.toHaveProperty('type');
    expect(result).not.toHaveProperty('lifeSpan');
    expect(result.aliases).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(result.releaseGroups).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.externalLinks).toEqual([]);
    // Output validates against the tool's own schema.
    expect(() => getArtistTool.output.parse(result)).not.toThrow();
  });

  it('maps an upstream 400 to ctx.fail("invalid_mbid")', async () => {
    lookupMock.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ValidationError, 'Invalid mbid.'),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: getArtistTool.errors });
    const input = getArtistTool.input.parse({ mbid: '0' });
    await expect(getArtistTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_mbid' },
    });
  });

  it('maps an upstream 404 to ctx.fail("entity_not_found")', async () => {
    lookupMock.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.NotFound, 'Not Found'));
    const ctx = createMockContext({ tenantId: 'test', errors: getArtistTool.errors });
    const input = getArtistTool.input.parse({ mbid: '00000000-0000-0000-0000-000000000001' });
    await expect(getArtistTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'entity_not_found' },
    });
  });

  it('discloses truncation when the discography hits the one-page cap', async () => {
    const releaseGroups = Array.from({ length: 25 }, (_, i) => ({
      id: `rg${i}`,
      title: `Album ${i}`,
    }));
    lookupMock.mockResolvedValueOnce({
      id: 'prolific',
      name: 'Prolific',
      'release-groups': releaseGroups,
    });
    const ctx = createMockContext({ tenantId: 'test', errors: getArtistTool.errors });
    const input = getArtistTool.input.parse({ mbid: 'prolific' });
    await getArtistTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(25);
    expect(enrichment.notice).toContain('browse_entities');
    expect(enrichment.notice).toContain('release_group_status=website-default');
  });
});

describe('artist relationship credits', () => {
  it('filters release credits before paging, preserving repeated targets and keeping profile data separate', async () => {
    const release = { id: 'edition', title: 'Named Edition', disambiguation: 'CD reissue' };
    const raw = {
      ...fullArtist,
      relations: [
        ...fullArtist.relations!,
        { type: 'mastering', 'target-type': 'release', release: { id: 'unmatched' } },
        { type: 'producer', 'target-type': 'recording', recording: { id: 'other-target' } },
        {
          type: 'producer',
          direction: 'forward',
          'target-type': 'release',
          release,
          attributes: ['co'],
          'ordering-key': 0,
          begin: '1995',
          end: '1996-02',
        },
        { type: 'mix', 'target-type': 'release', release },
        { type: 'engineer', 'target-type': 'release', release: { title: 'Sparse Edition' } },
      ],
    } satisfies RawArtist;
    lookupMock.mockResolvedValue(raw);
    const args = {
      mbid: fullArtist.id,
      credits: 'release',
      credit_types: ' Producer | Mix |ENGINEER ',
      credits_limit: 1,
    } as const;
    const first = await runToolContract(getArtistTool, args);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      relationships: [{ targetType: 'artist', targetId: 'thom' }],
      externalLinks: [{ type: 'wikidata' }],
      creditsOffset: 0,
      totalCount: 3,
      creditsNotice: expect.stringContaining('credits_offset=1'),
      credits: [
        {
          type: 'producer',
          direction: 'forward',
          targetType: 'release',
          targetId: 'edition',
          targetName: 'Named Edition',
          targetDisambiguation: 'CD reissue',
          attributes: ['co'],
          orderingKey: 0,
          begin: '1995',
          end: '1996-02',
        },
      ],
    });
    const text = JSON.stringify(first.content);
    expect(text).toContain('### Credits');
    expect(text).toContain(
      '**producer** (co) forward → release: Named Edition (edition) — CD reissue [1995–1996-02] [ordering key: 0]',
    );
    expect(text).toContain('**creditsOffset:** 0');
    expect(text).toContain('**totalCount:** 3');
    expect(text).toContain('credits_offset=1');
    expect(text).not.toContain('unmatched');

    const second = await runToolContract(getArtistTool, { ...args, credits_offset: 1 });
    expect(second.structuredContent).toMatchObject({
      creditsOffset: 1,
      totalCount: 3,
      creditsNotice: expect.stringContaining('credits_offset=2'),
      credits: [{ type: 'mix', targetId: 'edition' }],
    });
    expect(JSON.stringify(second.content)).toContain('**mix**');

    const last = await runToolContract(getArtistTool, { ...args, credits_offset: 2 });
    expect(last.structuredContent).toMatchObject({
      creditsOffset: 2,
      totalCount: 3,
      credits: [{ type: 'engineer', targetType: 'release', targetName: 'Sparse Edition' }],
    });
    expect(last.structuredContent).not.toHaveProperty('credits.0.targetId');
    expect(last.structuredContent).not.toHaveProperty('creditsNotice');
    expect(JSON.stringify(last.content)).toContain('Sparse Edition');
    expect(lookupMock.mock.calls.map((call) => call[2])).toEqual(
      Array.from({ length: 3 }, () => ({
        inc: [
          'aliases',
          'tags',
          'genres',
          'release-groups',
          'artist-rels',
          'url-rels',
          'release-rels',
        ],
      })),
    );
    expect(raw.relations).toHaveLength(7);
  });

  it('pages recording credits at the default and maximum limits with profile relationships disabled', async () => {
    const recordings = Array.from(
      { length: 101 },
      (_, index): RawRelation => ({
        type: 'producer',
        'target-type': 'recording',
        recording: { id: `recording-${index}`, title: `Track ${index}` },
      }),
    );
    lookupMock.mockResolvedValue({
      ...fullArtist,
      relations: [...fullArtist.relations!, ...recordings],
    });
    const args = { mbid: fullArtist.id, credits: 'recording', inc_relationships: false } as const;
    const defaultPage = await runToolContract(getArtistTool, args);
    expect(defaultPage.structuredContent).toMatchObject({
      relationships: [],
      externalLinks: [],
      totalCount: 101,
      creditsNotice: expect.stringContaining('credits_offset=25'),
    });
    expect(getArtistTool.output.parse(defaultPage.structuredContent).credits).toHaveLength(25);
    expect(JSON.stringify(defaultPage.content)).not.toContain('Thom Yorke');
    const maxPage = await runToolContract(getArtistTool, { ...args, credits_limit: 100 });
    expect(getArtistTool.output.parse(maxPage.structuredContent).credits).toHaveLength(100);
    expect(maxPage.structuredContent).toHaveProperty(
      'creditsNotice',
      expect.stringContaining('credits_offset=100'),
    );
    const tail = await runToolContract(getArtistTool, { ...args, credits_offset: 100 });
    expect(tail.structuredContent).toMatchObject({
      credits: [{ targetId: 'recording-100', targetName: 'Track 100' }],
      totalCount: 101,
      creditsOffset: 100,
    });
    expect(JSON.stringify(tail.content)).toContain('Track 100');
    expect(lookupMock.mock.calls[0]?.[2]).toEqual({
      inc: ['aliases', 'tags', 'genres', 'release-groups', 'recording-rels'],
    });
  });

  it.each([
    {
      credit_types: 'mix',
      credits_offset: 3,
      total: 0,
      notice: 'No recording credit relationships',
    },
    { credit_types: 'producer', credits_offset: 3, total: 1, notice: 'Credit page exhausted' },
  ])('describes a zero-row page with $notice', async ({ total, notice, ...args }) => {
    lookupMock.mockResolvedValueOnce({
      ...fullArtist,
      relations: [{ type: 'producer', 'target-type': 'recording' }],
    } satisfies RawArtist);
    const result = await runToolContract(getArtistTool, {
      mbid: fullArtist.id,
      credits: 'recording',
      ...args,
    });
    expect(result.structuredContent).toMatchObject({
      credits: [],
      creditsOffset: 3,
      totalCount: total,
      creditsNotice: expect.stringContaining(notice),
    });
    expect(JSON.stringify(result.content)).toContain(notice);
  });

  it.each([
    [{ credit_types: 'producer' }, 'invalid_credit_filter'],
    [{ credits_offset: 0 }, 'invalid_credit_filter'],
    [{ credits_limit: 25 }, 'invalid_credit_filter'],
    [{ credits: 'release', credit_types: 'mix| |engineer' }, 'invalid_credit_filter'],
    [{ credits: 'recording', credits_limit: 101 }, 'invalid_arguments'],
    [{ credits: 'recording', credits_offset: -1 }, 'invalid_arguments'],
    [{ credits: 'work' }, 'invalid_arguments'],
  ] as const)('rejects invalid credit controls %j before lookup', async (args, reason) => {
    const result = await runToolContract(getArtistTool, { mbid: fullArtist.id, ...args } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: { hint: expect.any(String) } } },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(reason);
    if (reason === 'invalid_credit_filter') expect(text).toContain('Recovery:');
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
