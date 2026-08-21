/**
 * @fileoverview Tests for the get_artist tool handler: full payload, sparse
 * payload (omitted upstream fields preserved as absent), error-contract mapping
 * (invalid_mbid / entity_not_found), and discography truncation enrichment.
 * The MusicBrainz service is mocked at the accessor boundary.
 * @module tests/tools/get-artist.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawArtist } from '@/services/musicbrainz/types.js';

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
  });
});
